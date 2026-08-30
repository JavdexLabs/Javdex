// SQLite schema. Executed on startup (idempotent via IF NOT EXISTS).

// Immutable v8 schema snapshot. Later classification changes belong in later migrations.
export const CLASSIFICATION_V8_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    main_name TEXT NOT NULL,
    image_path TEXT,
    summary TEXT,
    country_region TEXT,
    founded_year INTEGER,
    ended_year INTEGER,
    status TEXT NOT NULL DEFAULT 'unknown'
        CHECK(status IN ('unknown', 'active', 'inactive')),
    parent_organization_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
    CHECK(founded_year IS NULL OR founded_year BETWEEN 1 AND 9999),
    CHECK(ended_year IS NULL OR ended_year BETWEEN 1 AND 9999),
    CHECK(founded_year IS NULL OR ended_year IS NULL OR founded_year <= ended_year)
);
CREATE INDEX IF NOT EXISTS idx_organizations_parent
    ON organizations(parent_organization_id);
CREATE INDEX IF NOT EXISTS idx_organizations_updated_at
    ON organizations(updated_at);

CREATE TABLE IF NOT EXISTS organization_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    normalized_name TEXT NOT NULL CHECK(length(normalized_name) > 0),
    type TEXT NOT NULL CHECK(type IN ('main', 'alias')),
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_organization_names_normalized
    ON organization_names(normalized_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_names_one_main
    ON organization_names(organization_id)
    WHERE type = 'main';

CREATE TABLE IF NOT EXISTS organization_name_ownership (
    normalized_name TEXT PRIMARY KEY CHECK(length(normalized_name) > 0),
    organization_id INTEGER NOT NULL,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_organization_name_ownership_organization
    ON organization_name_ownership(organization_id);

CREATE TABLE IF NOT EXISTS organization_roles (
    organization_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('maker', 'publisher')),
    PRIMARY KEY (organization_id, role),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_organization_roles_role
    ON organization_roles(role);

CREATE TABLE IF NOT EXISTS organization_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    UNIQUE (organization_id, normalized_url)
);
CREATE INDEX IF NOT EXISTS idx_organization_links_organization
    ON organization_links(organization_id, position);

CREATE TABLE IF NOT EXISTS directors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    main_name TEXT NOT NULL,
    image_path TEXT,
    summary TEXT,
    country_region TEXT,
    birth_date TEXT,
    death_date TEXT,
    birth_place TEXT,
    career_start_year INTEGER,
    career_end_year INTEGER,
    status TEXT NOT NULL DEFAULT 'unknown'
        CHECK(status IN ('unknown', 'active', 'paused', 'retired', 'deceased')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(career_start_year IS NULL OR career_start_year BETWEEN 1 AND 9999),
    CHECK(career_end_year IS NULL OR career_end_year BETWEEN 1 AND 9999),
    CHECK(career_start_year IS NULL OR career_end_year IS NULL OR career_start_year <= career_end_year),
    CHECK(birth_date IS NULL OR death_date IS NULL OR birth_date <= death_date)
);
CREATE INDEX IF NOT EXISTS idx_directors_updated_at ON directors(updated_at);

CREATE TABLE IF NOT EXISTS director_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    director_id INTEGER NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    normalized_name TEXT NOT NULL CHECK(length(normalized_name) > 0),
    type TEXT NOT NULL CHECK(type IN ('main', 'alias')),
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (director_id) REFERENCES directors(id) ON DELETE CASCADE,
    UNIQUE (director_id, name)
);
CREATE INDEX IF NOT EXISTS idx_director_names_normalized
    ON director_names(normalized_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_director_names_one_main
    ON director_names(director_id)
    WHERE type = 'main';

CREATE TABLE IF NOT EXISTS director_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    director_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (director_id) REFERENCES directors(id) ON DELETE CASCADE,
    UNIQUE (director_id, normalized_url)
);
CREATE INDEX IF NOT EXISTS idx_director_links_director
    ON director_links(director_id, position);

CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    main_name TEXT NOT NULL,
    image_path TEXT,
    summary TEXT,
    owner_organization_id INTEGER,
    parent_series_id INTEGER,
    start_year INTEGER,
    end_year INTEGER,
    status TEXT NOT NULL DEFAULT 'unknown'
        CHECK(status IN ('unknown', 'ongoing', 'completed', 'discontinued')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_series_id) REFERENCES series(id) ON DELETE SET NULL,
    CHECK(start_year IS NULL OR start_year BETWEEN 1 AND 9999),
    CHECK(end_year IS NULL OR end_year BETWEEN 1 AND 9999),
    CHECK(start_year IS NULL OR end_year IS NULL OR start_year <= end_year)
);
CREATE INDEX IF NOT EXISTS idx_series_owner ON series(owner_organization_id);
CREATE INDEX IF NOT EXISTS idx_series_parent ON series(parent_series_id);
CREATE INDEX IF NOT EXISTS idx_series_updated_at ON series(updated_at);

CREATE TABLE IF NOT EXISTS series_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    normalized_name TEXT NOT NULL CHECK(length(normalized_name) > 0),
    type TEXT NOT NULL CHECK(type IN ('main', 'alias')),
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
    UNIQUE (series_id, name)
);
CREATE INDEX IF NOT EXISTS idx_series_names_normalized
    ON series_names(normalized_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_series_names_one_main
    ON series_names(series_id)
    WHERE type = 'main';

CREATE TABLE IF NOT EXISTS series_name_ownership (
    owner_organization_id INTEGER,
    normalized_name TEXT NOT NULL CHECK(length(normalized_name) > 0),
    series_id INTEGER NOT NULL,
    FOREIGN KEY (owner_organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_series_name_ownership_scope
    ON series_name_ownership(COALESCE(owner_organization_id, 0), normalized_name);
CREATE INDEX IF NOT EXISTS idx_series_name_ownership_series
    ON series_name_ownership(series_id);

CREATE TABLE IF NOT EXISTS series_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
    UNIQUE (series_id, normalized_url)
);
CREATE INDEX IF NOT EXISTS idx_series_links_series
    ON series_links(series_id, position);
`

export const PENDING_LOCAL_FILE_DELETIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pending_local_file_deletions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_path TEXT NOT NULL UNIQUE,
    staged_path TEXT NOT NULL UNIQUE,
    device_id INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared', 'committed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pending_local_file_deletions_state
    ON pending_local_file_deletions(state);
`

export const VIDEO_SOURCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS video_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    external_code TEXT,
    url TEXT,
    title TEXT,
    fetched_at TEXT,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    UNIQUE (video_id, source)
);
CREATE INDEX IF NOT EXISTS idx_video_sources_video_id ON video_sources(video_id);
`

export const MEDIA_LIBRARY_CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS media_libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(trim(name)) > 0),
    icon TEXT NOT NULL DEFAULT 'library'
        CHECK(icon IN ('library', 'film', 'folder', 'hard-drive', 'cloud', 'star')),
    color TEXT NOT NULL DEFAULT 'slate'
        CHECK(color IN ('slate', 'blue', 'violet', 'rose', 'amber', 'green')),
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_libraries_one_default
    ON media_libraries(is_default) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_media_libraries_status_position
    ON media_libraries(status, position, id);

CREATE TABLE IF NOT EXISTS media_library_configs (
    library_id INTEGER PRIMARY KEY,
    auto_scan_enabled INTEGER NOT NULL DEFAULT 0 CHECK(auto_scan_enabled IN (0, 1)),
    auto_scan_interval_minutes INTEGER NOT NULL DEFAULT 1440
        CHECK(auto_scan_interval_minutes BETWEEN 5 AND 10080),
    min_import_duration_minutes INTEGER NOT NULL DEFAULT 30
        CHECK(min_import_duration_minutes BETWEEN 0 AND 1440),
    auto_merge_same_code_resources INTEGER NOT NULL DEFAULT 1
        CHECK(auto_merge_same_code_resources IN (0, 1)),
    remove_resource_less_memberships INTEGER NOT NULL DEFAULT 0
        CHECK(remove_resource_less_memberships IN (0, 1)),
    default_video_scraper TEXT,
    default_sort_by TEXT NOT NULL DEFAULT 'release_date'
        CHECK(default_sort_by IN ('add_time', 'release_date', 'rating', 'code')),
    default_sort_dir TEXT NOT NULL DEFAULT 'desc' CHECK(default_sort_dir IN ('asc', 'desc')),
    include_in_home_discovery INTEGER NOT NULL DEFAULT 1
        CHECK(include_in_home_discovery IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    legacy_settings_imported_at TEXT,
    FOREIGN KEY (library_id) REFERENCES media_libraries(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_library_roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL,
    path TEXT NOT NULL CHECK(length(trim(path)) > 0),
    normalized_path TEXT NOT NULL CHECK(length(normalized_path) > 0),
    real_path TEXT,
    normalized_real_path TEXT,
    device_id TEXT,
    inode TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'active'
        CHECK(state IN ('active', 'pending_removal', 'disabled', 'archived')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (library_id) REFERENCES media_libraries(id) ON DELETE CASCADE,
    UNIQUE (id, library_id),
    CHECK((real_path IS NULL) = (normalized_real_path IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_library_roots_managed_path
    ON media_library_roots(normalized_path)
    WHERE state IN ('active', 'pending_removal');
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_library_roots_managed_real_path
    ON media_library_roots(normalized_real_path)
    WHERE state IN ('active', 'pending_removal') AND normalized_real_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_library_roots_library_state_position
    ON media_library_roots(library_id, state, position, id);

INSERT OR IGNORE INTO media_libraries (
    id, name, position, status, is_default, revision
) VALUES (1, '默认媒体库', 0, 'active', 1, 1);
INSERT OR IGNORE INTO media_library_configs (library_id) VALUES (1);
`

export const MEDIA_LIBRARY_MEMBERSHIP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS library_video_memberships (
    library_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    added_via TEXT NOT NULL DEFAULT 'manual' CHECK(added_via IN ('scan', 'manual', 'shared')),
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
    is_hidden INTEGER NOT NULL DEFAULT 0 CHECK(is_hidden IN (0, 1)),
    discovery_key INTEGER NOT NULL CHECK(discovery_key BETWEEN 0 AND 2147483647),
    PRIMARY KEY (library_id, video_id),
    FOREIGN KEY (library_id) REFERENCES media_libraries(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_library_video_memberships_video
    ON library_video_memberships(video_id, library_id);
CREATE INDEX IF NOT EXISTS idx_library_video_memberships_library_added
    ON library_video_memberships(library_id, is_hidden, added_at DESC, video_id);
CREATE INDEX IF NOT EXISTS idx_library_video_memberships_recent
    ON library_video_memberships(is_hidden, added_at DESC, video_id, library_id);
CREATE INDEX IF NOT EXISTS idx_library_video_memberships_discovery
    ON library_video_memberships(library_id, is_hidden, discovery_key, video_id);

CREATE TABLE IF NOT EXISTS video_lifecycle_operations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('remove-from-library', 'move-resource', 'delete-globally')),
    input_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_lifecycle_operations_created
    ON video_lifecycle_operations(created_at);
`

export const MEDIA_LIBRARY_VIDEO_RESOURCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS video_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    root_id INTEGER,
    kind TEXT NOT NULL CHECK(kind IN ('local', 'direct', 'web', 'magnet', 'ed2k')),
    locator TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    source_identity TEXT,
    strm_source_path TEXT,
    size_bytes INTEGER,
    duration_seconds INTEGER,
    file_mtime_ms INTEGER,
    display_name TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
    add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (library_id, video_id)
        REFERENCES library_video_memberships(library_id, video_id) ON DELETE CASCADE,
    FOREIGN KEY (root_id, library_id)
        REFERENCES media_library_roots(id, library_id) ON DELETE RESTRICT,
    UNIQUE (library_id, resource_key),
    CHECK(
      (kind = 'local' AND source_identity IS NOT NULL AND strm_source_path IS NULL)
      OR (kind != 'local' AND strm_source_path IS NOT NULL AND source_identity IS NOT NULL)
      OR (kind != 'local' AND strm_source_path IS NULL AND source_identity IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_video_resources_video_id ON video_resources(video_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_resources_library_source_identity
    ON video_resources(library_id, source_identity) WHERE source_identity IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_resources_primary
    ON video_resources(library_id, video_id) WHERE is_primary = 1;
CREATE INDEX IF NOT EXISTS idx_video_resources_library_video
    ON video_resources(library_id, video_id, is_primary, id);
CREATE INDEX IF NOT EXISTS idx_video_resources_library_video_kind
    ON video_resources(library_id, video_id, kind, is_primary DESC, add_time, id);
CREATE INDEX IF NOT EXISTS idx_video_resources_library_kind
    ON video_resources(library_id, kind, video_id);
CREATE INDEX IF NOT EXISTS idx_video_resources_root ON video_resources(root_id);
CREATE INDEX IF NOT EXISTS idx_video_resources_strm_source_path
    ON video_resources(library_id, strm_source_path);
`

export const MEDIA_LIBRARY_PENDING_SCAN_RESOURCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pending_scan_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    root_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    normalized_path TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'local' CHECK(source_kind IN ('local', 'strm')),
    target_kind TEXT CHECK(target_kind IN ('direct', 'web', 'magnet', 'ed2k')),
    target_locator TEXT,
    target_key TEXT,
    size_bytes INTEGER,
    duration_seconds INTEGER,
    file_mtime_ms INTEGER,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id, library_id)
        REFERENCES pending_scan_groups(id, library_id) ON DELETE CASCADE,
    FOREIGN KEY (root_id, library_id)
        REFERENCES media_library_roots(id, library_id) ON DELETE RESTRICT,
    UNIQUE (library_id, normalized_path)
);
CREATE INDEX IF NOT EXISTS idx_pending_scan_resources_group
    ON pending_scan_resources(library_id, group_id);
CREATE INDEX IF NOT EXISTS idx_pending_scan_resources_root
    ON pending_scan_resources(library_id, root_id);
`

export const MEDIA_LIBRARY_PENDING_SCAN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pending_scan_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL,
    normalized_code TEXT NOT NULL CHECK(length(normalized_code) > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (library_id) REFERENCES media_libraries(id) ON DELETE CASCADE,
    UNIQUE (library_id, normalized_code),
    UNIQUE (id, library_id)
);
CREATE INDEX IF NOT EXISTS idx_pending_scan_groups_library_updated
    ON pending_scan_groups(library_id, updated_at, id);

${MEDIA_LIBRARY_PENDING_SCAN_RESOURCES_SCHEMA_SQL}
`

export const MEDIA_LIBRARY_SCAN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS library_scan_runs (
    id TEXT PRIMARY KEY,
    library_id INTEGER NOT NULL,
    config_revision INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('manual', 'automatic', 'initial', 'root')),
    status TEXT NOT NULL
        CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'unavailable')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    summary_json TEXT,
    audit_json TEXT,
    error_summary TEXT,
    FOREIGN KEY (library_id) REFERENCES media_libraries(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_library_scan_runs_library_started
    ON library_scan_runs(library_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_library_scan_runs_status_started
    ON library_scan_runs(status, started_at);

CREATE TABLE IF NOT EXISTS media_library_scan_state (
    library_id INTEGER PRIMARY KEY,
    active_run_id TEXT,
    last_status TEXT CHECK(last_status IS NULL OR last_status IN
        ('queued', 'running', 'completed', 'failed', 'cancelled', 'unavailable')),
    last_started_at TEXT,
    last_finished_at TEXT,
    last_successful_at TEXT,
    last_summary_json TEXT,
    last_error TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    FOREIGN KEY (library_id) REFERENCES media_libraries(id) ON DELETE CASCADE,
    FOREIGN KEY (active_run_id) REFERENCES library_scan_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS library_unrecognized_files (
    library_id INTEGER NOT NULL,
    root_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    normalized_path TEXT NOT NULL,
    reason TEXT,
    scan_run_id TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (library_id, normalized_path),
    FOREIGN KEY (root_id, library_id)
        REFERENCES media_library_roots(id, library_id) ON DELETE CASCADE,
    FOREIGN KEY (scan_run_id) REFERENCES library_scan_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_library_unrecognized_files_root
    ON library_unrecognized_files(library_id, root_id, normalized_path);

CREATE TABLE IF NOT EXISTS library_root_cleanup_jobs (
    id TEXT PRIMARY KEY,
    library_id INTEGER NOT NULL,
    root_id INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    requested_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    last_error TEXT,
    root_path TEXT NOT NULL,
    normalized_root_path TEXT NOT NULL,
    normalized_real_path TEXT,
    device_id TEXT,
    inode TEXT,
    config_revision INTEGER NOT NULL,
    FOREIGN KEY (root_id, library_id)
        REFERENCES media_library_roots(id, library_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_library_root_cleanup_jobs_active_root
    ON library_root_cleanup_jobs(root_id)
    WHERE state IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_library_root_cleanup_jobs_library_state
    ON library_root_cleanup_jobs(library_id, state, requested_at);

INSERT OR IGNORE INTO media_library_scan_state (library_id) VALUES (1);
`

/** Immutable pre-multi-library pending-scan schema used by the V11 migration. */
export const LEGACY_PENDING_SCAN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pending_scan_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    normalized_code TEXT NOT NULL UNIQUE CHECK(length(normalized_code) > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pending_scan_groups_updated_at
    ON pending_scan_groups(updated_at);

CREATE TABLE IF NOT EXISTS pending_scan_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    normalized_path TEXT NOT NULL UNIQUE,
    scan_root TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'local' CHECK(source_kind IN ('local', 'strm')),
    target_kind TEXT CHECK(target_kind IN ('direct', 'web', 'magnet', 'ed2k')),
    target_locator TEXT,
    target_key TEXT,
    size_bytes INTEGER,
    duration_seconds INTEGER,
    file_mtime_ms INTEGER,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES pending_scan_groups(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pending_scan_resources_group
    ON pending_scan_resources(group_id);
CREATE INDEX IF NOT EXISTS idx_pending_scan_resources_root
    ON pending_scan_resources(scan_root);
`

export const PENDING_VIDEO_SCRAPES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pending_video_scrapes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL UNIQUE,
    revision INTEGER NOT NULL DEFAULT 1,
    selected_fields_json TEXT NOT NULL,
    applicable_fields_json TEXT NOT NULL,
    update_mode TEXT NOT NULL CHECK(update_mode IN ('replace', 'fillEmpty', 'replaceIfPresent')),
    request_json TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    batch_job_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pending_video_scrapes_created_at
    ON pending_video_scrapes(created_at);

CREATE TABLE IF NOT EXISTS pending_video_scrape_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pending_scrape_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    plugin_name TEXT NOT NULL,
    plugin_source TEXT NOT NULL CHECK(plugin_source IN ('builtin', 'user', 'composite')),
    plugin_version TEXT,
    plugin_config_json TEXT NOT NULL,
    source_name TEXT NOT NULL,
    selected_fields_json TEXT NOT NULL,
    selected_candidate_id INTEGER,
    FOREIGN KEY (pending_scrape_id) REFERENCES pending_video_scrapes(id) ON DELETE CASCADE,
    UNIQUE (pending_scrape_id, position)
);
CREATE INDEX IF NOT EXISTS idx_pending_video_scrape_sources_pending
    ON pending_video_scrape_sources(pending_scrape_id);

CREATE TABLE IF NOT EXISTS pending_video_scrape_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    result_json TEXT NOT NULL,
    source_url TEXT,
    normalized_source_url TEXT,
    FOREIGN KEY (source_id) REFERENCES pending_video_scrape_sources(id) ON DELETE CASCADE,
    UNIQUE (source_id, position)
);
CREATE INDEX IF NOT EXISTS idx_pending_video_scrape_candidates_source
    ON pending_video_scrape_candidates(source_id);

CREATE TABLE IF NOT EXISTS pending_video_scrape_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    field TEXT NOT NULL CHECK(field IN ('cover', 'samples', 'actressAvatar')),
    position INTEGER NOT NULL DEFAULT 0,
    remote_url TEXT,
    staged_path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER,
    FOREIGN KEY (candidate_id) REFERENCES pending_video_scrape_candidates(id) ON DELETE CASCADE,
    UNIQUE (candidate_id, field, position)
);
CREATE INDEX IF NOT EXISTS idx_pending_video_scrape_resources_candidate
    ON pending_video_scrape_resources(candidate_id);
`

/** Immutable V11 decision schema. Fresh databases use the library-scoped scan schema below. */
export const PENDING_VIDEO_DECISIONS_SCHEMA_SQL = `
${LEGACY_PENDING_SCAN_SCHEMA_SQL}
${PENDING_VIDEO_SCRAPES_SCHEMA_SQL}
`

export const RELATED_LINKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS video_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    UNIQUE (video_id, normalized_url)
);
CREATE INDEX IF NOT EXISTS idx_video_links_video
    ON video_links(video_id, position);

CREATE TABLE IF NOT EXISTS actress_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actress_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE,
    UNIQUE (actress_id, normalized_url)
);
CREATE INDEX IF NOT EXISTS idx_actress_links_actress
    ON actress_links(actress_id, position);

CREATE TABLE IF NOT EXISTS playlist_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    UNIQUE (playlist_id, normalized_url)
);
CREATE INDEX IF NOT EXISTS idx_playlist_links_playlist
    ON playlist_links(playlist_id, position);
`

export const AGENT_PLATFORM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    use_case TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('created', 'running', 'waiting_user', 'settled', 'failed', 'cancelled', 'recovering', 'closed')),
    active_operation_id TEXT,
    config_revision TEXT NOT NULL,
    config_snapshot_json TEXT NOT NULL,
    runtime_id TEXT NOT NULL CHECK(runtime_id = 'pi'),
    runtime_session_ref_json TEXT,
    recovery_generation INTEGER NOT NULL DEFAULT 0,
    recovery_attempted_generation INTEGER NOT NULL DEFAULT -1,
    product_state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_updated
    ON agent_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS agent_operations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    command_kind TEXT NOT NULL CHECK(command_kind IN ('prompt', 'steer', 'follow-up', 'compact', 'abort')),
    idempotency_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('accepted', 'settled', 'rejected', 'failed')),
    created_at TEXT NOT NULL,
    settled_at TEXT,
    error TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
    UNIQUE (run_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_operations_run_status
    ON agent_operations(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS agent_product_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    operation_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_product_journal_run_seq
    ON agent_product_journal(run_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_product_journal_operation
    ON agent_product_journal(run_id, event_type, operation_id)
    WHERE operation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_execution_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    runtime_id TEXT NOT NULL CHECK(runtime_id = 'pi'),
    codec_version INTEGER NOT NULL,
    audit_json TEXT NOT NULL,
    recovery_ciphertext BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    retain_until TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_execution_history_run_seq
    ON agent_execution_history(run_id, seq);

CREATE TABLE IF NOT EXISTS agent_tool_ledger (
    call_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    operation_id TEXT,
    tool_name TEXT NOT NULL,
    args_digest TEXT NOT NULL,
    effect TEXT NOT NULL CHECK(effect IN ('read', 'write', 'network', 'install', 'credential-sensitive')),
    status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'interrupted', 'uncertain', 'denied')),
    result_json TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    reconciliation_json TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_tool_ledger_run_status
    ON agent_tool_ledger(run_id, status, started_at);

CREATE TABLE IF NOT EXISTS agent_approvals (
    request_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    args_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'consumed')),
    permit_ciphertext BLOB,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_run_status
    ON agent_approvals(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS agent_artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    ref_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_artifacts_run_created
    ON agent_artifacts(run_id, created_at);
`

export const AGENT_METADATA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_metadata_drafts (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    entity_kind TEXT NOT NULL CHECK(entity_kind IN ('video', 'actress')),
    entity_id INTEGER NOT NULL,
    adapter_schema_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('ready', 'applied', 'routed_to_pending', 'discarded', 'failed')),
    revision INTEGER NOT NULL DEFAULT 1,
    requested_url TEXT NOT NULL,
    resolved_url TEXT,
    display_url TEXT NOT NULL,
    source_name TEXT,
    page_title TEXT,
    payload_json TEXT NOT NULL,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    review_json TEXT,
    review_token TEXT,
    apply_idempotency_key TEXT,
    outcome_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    applied_at TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_metadata_drafts_ready_target
    ON agent_metadata_drafts(entity_kind, entity_id) WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_agent_metadata_drafts_run
    ON agent_metadata_drafts(run_id, updated_at);

CREATE TABLE IF NOT EXISTS agent_metadata_draft_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id TEXT NOT NULL,
    field TEXT NOT NULL CHECK(field IN ('cover', 'samples', 'actressAvatar', 'avatar', 'gallery')),
    position INTEGER NOT NULL DEFAULT 0,
    remote_url TEXT,
    staged_path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    FOREIGN KEY (draft_id) REFERENCES agent_metadata_drafts(id) ON DELETE CASCADE,
    UNIQUE (draft_id, field, position)
);
CREATE INDEX IF NOT EXISTS idx_agent_metadata_draft_resources_draft
    ON agent_metadata_draft_resources(draft_id, field, position);
`

export const PLAYLIST_IMPORT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS playlist_import_jobs (
    run_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    input_hash TEXT NOT NULL,
    policy_version INTEGER NOT NULL DEFAULT 1,
    phase TEXT NOT NULL CHECK(phase IN (
      'discovering-list', 'resolving-identities', 'waiting_user',
      'ready-to-apply', 'applying', 'completed', 'failed', 'cancelled'
    )),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    source_url TEXT NOT NULL,
    normalized_source_url TEXT NOT NULL,
    source_host TEXT NOT NULL,
    destination_kind TEXT NOT NULL CHECK(destination_kind IN ('create', 'append')),
    requested_playlist_id INTEGER,
    requested_playlist_name TEXT,
    agent_suggested_playlist_name TEXT,
    resolved_playlist_id INTEGER,
    target_library_id INTEGER NOT NULL,
    target_library_name_snapshot TEXT NOT NULL,
    auto_create_unmatched_videos INTEGER NOT NULL DEFAULT 1
        CHECK(auto_create_unmatched_videos IN (0, 1)),
    save_detail_links INTEGER NOT NULL DEFAULT 1 CHECK(save_detail_links IN (0, 1)),
    save_source_playlist_link INTEGER NOT NULL DEFAULT 0
        CHECK(save_source_playlist_link IN (0, 1)),
    counters_json TEXT NOT NULL DEFAULT '{}',
    apply_idempotency_key TEXT,
    outcome_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    committed_at TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (resolved_playlist_id) REFERENCES playlists(id) ON DELETE SET NULL,
    CHECK(
      (destination_kind = 'create' AND requested_playlist_id IS NULL)
      OR (destination_kind = 'append' AND requested_playlist_id IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS playlist_import_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    page_key TEXT NOT NULL,
    page_order INTEGER NOT NULL CHECK(page_order >= 0),
    page_url TEXT NOT NULL,
    normalized_page_url TEXT NOT NULL,
    document_revision TEXT NOT NULL,
    initial_view_revision TEXT NOT NULL,
    enumeration_kind TEXT NOT NULL CHECK(enumeration_kind IN (
      'static-dom', 'virtual-scroll', 'load-more'
    )),
    enumeration_status TEXT NOT NULL CHECK(enumeration_status IN ('open', 'sealed')),
    container_contract_json TEXT,
    position_mode TEXT CHECK(position_mode IS NULL OR position_mode IN (
      'aria-posinset', 'attribute', 'overlap'
    )),
    sequence_digest TEXT,
    content_hash TEXT,
    evidence_ref TEXT NOT NULL,
    advance_json TEXT,
    observed_item_count INTEGER NOT NULL DEFAULT 0 CHECK(observed_item_count >= 0),
    declared_total_items INTEGER,
    declared_total_pages INTEGER,
    checkpointed_at TEXT NOT NULL,
    sealed_at TEXT,
    FOREIGN KEY (run_id) REFERENCES playlist_import_jobs(run_id) ON DELETE CASCADE,
    UNIQUE (run_id, page_key),
    UNIQUE (run_id, page_order)
);
CREATE INDEX IF NOT EXISTS idx_playlist_import_pages_url
    ON playlist_import_pages(run_id, normalized_page_url);

CREATE TABLE IF NOT EXISTS playlist_import_scroll_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL,
    batch_order INTEGER NOT NULL CHECK(batch_order >= 0),
    operation_key TEXT NOT NULL,
    view_revision TEXT NOT NULL,
    container_fingerprint TEXT NOT NULL,
    scroll_top REAL NOT NULL,
    scroll_height REAL NOT NULL,
    client_height REAL NOT NULL,
    ordered_occurrence_keys_json TEXT NOT NULL,
    rendered_item_count INTEGER NOT NULL CHECK(rendered_item_count >= 0),
    new_occurrence_count INTEGER NOT NULL CHECK(new_occurrence_count >= 0),
    batch_digest TEXT NOT NULL,
    accumulated_sequence_digest TEXT NOT NULL,
    first_anchor_key TEXT,
    last_anchor_key TEXT,
    at_start INTEGER NOT NULL CHECK(at_start IN (0, 1)),
    at_end INTEGER NOT NULL CHECK(at_end IN (0, 1)),
    terminal_probe_count INTEGER NOT NULL DEFAULT 0 CHECK(terminal_probe_count >= 0),
    evidence_ref TEXT NOT NULL,
    checkpointed_at TEXT NOT NULL,
    FOREIGN KEY (page_id) REFERENCES playlist_import_pages(id) ON DELETE CASCADE,
    UNIQUE (page_id, batch_order),
    UNIQUE (page_id, operation_key)
);
CREATE INDEX IF NOT EXISTS idx_playlist_import_scroll_batches_page
    ON playlist_import_scroll_batches(page_id, batch_order);

CREATE TABLE IF NOT EXISTS playlist_import_frontier (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    source_page_id INTEGER,
    kind TEXT NOT NULL CHECK(kind IN ('url', 'click', 'scroll')),
    target_json TEXT NOT NULL,
    canonical_key TEXT NOT NULL,
    order_hint INTEGER,
    status TEXT NOT NULL CHECK(status IN (
      'pending', 'in-flight', 'checkpointed', 'no-progress', 'denied'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    replay_chain_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES playlist_import_jobs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (source_page_id) REFERENCES playlist_import_pages(id) ON DELETE CASCADE,
    UNIQUE (run_id, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_playlist_import_frontier_next
    ON playlist_import_frontier(run_id, status, order_hint, id);

CREATE TABLE IF NOT EXISTS playlist_import_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    first_page_id INTEGER NOT NULL,
    source_position INTEGER NOT NULL CHECK(source_position >= 0),
    raw_code TEXT,
    normalized_code TEXT,
    title TEXT,
    detail_url TEXT NOT NULL,
    normalized_detail_url TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
      'discovered', 'needs-detail', 'needs-user',
      'planned-reuse', 'planned-create', 'applied', 'failed'
    )),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    candidate_snapshot_json TEXT,
    detail_identity_json TEXT,
    detail_evidence_ref TEXT,
    resolution_kind TEXT CHECK(resolution_kind IS NULL OR resolution_kind IN (
      'direct-code', 'detail-url', 'source-id', 'business-identity',
      'target-library-tiebreak', 'user-existing', 'user-create', 'create-no-match'
    )),
    resolved_video_id INTEGER,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES playlist_import_jobs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (first_page_id) REFERENCES playlist_import_pages(id) ON DELETE CASCADE,
    FOREIGN KEY (resolved_video_id) REFERENCES videos(id) ON DELETE SET NULL,
    UNIQUE (run_id, normalized_detail_url),
    UNIQUE (run_id, source_position)
);
CREATE INDEX IF NOT EXISTS idx_playlist_import_items_state
    ON playlist_import_items(run_id, state, source_position);
CREATE INDEX IF NOT EXISTS idx_playlist_import_items_code
    ON playlist_import_items(run_id, normalized_code);

CREATE TABLE IF NOT EXISTS playlist_import_page_items (
    page_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    source_occurrence_key TEXT NOT NULL,
    source_position INTEGER NOT NULL CHECK(source_position >= 0),
    page_position INTEGER NOT NULL CHECK(page_position >= 0),
    raw_evidence_json TEXT NOT NULL,
    PRIMARY KEY (page_id, source_occurrence_key),
    FOREIGN KEY (page_id) REFERENCES playlist_import_pages(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES playlist_import_items(id) ON DELETE CASCADE,
    UNIQUE (page_id, page_position)
);
CREATE INDEX IF NOT EXISTS idx_playlist_import_page_items_item
    ON playlist_import_page_items(item_id, page_id, page_position);

CREATE TABLE IF NOT EXISTS playlist_import_decisions (
    item_id INTEGER PRIMARY KEY,
    expected_item_revision INTEGER NOT NULL CHECK(expected_item_revision > 0),
    choice_kind TEXT NOT NULL CHECK(choice_kind IN ('existing', 'create')),
    chosen_video_id INTEGER,
    decided_at TEXT NOT NULL,
    FOREIGN KEY (item_id) REFERENCES playlist_import_items(id) ON DELETE CASCADE,
    FOREIGN KEY (chosen_video_id) REFERENCES videos(id) ON DELETE SET NULL,
    CHECK(
      (choice_kind = 'existing' AND chosen_video_id IS NOT NULL)
      OR (choice_kind = 'create' AND chosen_video_id IS NULL)
    )
);
`

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

${CLASSIFICATION_V8_SCHEMA_SQL}

${MEDIA_LIBRARY_CORE_SCHEMA_SQL}

CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL DEFAULT '',
    title TEXT,
    summary TEXT,
    cover_path TEXT,
    poster_path TEXT,
    original_title TEXT,
    rating INTEGER DEFAULT 0,
    release_date TEXT,
    maker_organization_id INTEGER,
    publisher_organization_id INTEGER,
    series_id INTEGER,
    director_id INTEGER,
    duration_seconds INTEGER,
    scraped_status INTEGER DEFAULT 0,
    last_scraped_at TEXT,
    updated_at TEXT,
    add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (maker_organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
    FOREIGN KEY (publisher_organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
    FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE SET NULL,
    FOREIGN KEY (director_id) REFERENCES directors(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_code ON videos(code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_business_identity
    ON videos(publisher_organization_id, upper(trim(code)), release_date)
    WHERE publisher_organization_id IS NOT NULL
      AND code IS NOT NULL AND length(trim(code)) > 0
      AND release_date IS NOT NULL AND length(trim(release_date)) > 0;
CREATE INDEX IF NOT EXISTS idx_videos_add_time ON videos(add_time);
CREATE INDEX IF NOT EXISTS idx_videos_release_date ON videos(release_date);
CREATE INDEX IF NOT EXISTS idx_videos_rating ON videos(rating);
CREATE INDEX IF NOT EXISTS idx_videos_scraped_status ON videos(scraped_status);
CREATE INDEX IF NOT EXISTS idx_videos_maker_organization_id ON videos(maker_organization_id);
CREATE INDEX IF NOT EXISTS idx_videos_publisher_organization_id ON videos(publisher_organization_id);
CREATE INDEX IF NOT EXISTS idx_videos_series_id ON videos(series_id);
CREATE INDEX IF NOT EXISTS idx_videos_director_id ON videos(director_id);

${MEDIA_LIBRARY_MEMBERSHIP_SCHEMA_SQL}

${MEDIA_LIBRARY_VIDEO_RESOURCES_SCHEMA_SQL}

${PENDING_LOCAL_FILE_DELETIONS_SCHEMA_SQL}

CREATE TABLE IF NOT EXISTS actresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    main_name TEXT UNIQUE NOT NULL,
    avatar_path TEXT,
    avatar_source_path TEXT,
    avatar_crop_json TEXT,
    poster_path TEXT,
    birth_date TEXT,
    debut_date TEXT,
    height_cm INTEGER,
    bust_cm INTEGER,
    waist_cm INTEGER,
    hip_cm INTEGER,
    cup_size TEXT,
    blood_type TEXT,
    zodiac TEXT,
    nationality TEXT,
    profile_summary TEXT,
    scraped_status INTEGER NOT NULL DEFAULT 0 CHECK(scraped_status IN (0, 1, 2)),
    last_scraped_at TEXT,
    updated_at TEXT,
    gender TEXT CHECK(gender IN ('female', 'male')),
    revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_actresses_scraped_status ON actresses(scraped_status);
CREATE TRIGGER IF NOT EXISTS trg_actresses_revision_after_update
AFTER UPDATE ON actresses
WHEN NEW.revision = OLD.revision
BEGIN
    UPDATE actresses SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS video_actress (
    video_id INTEGER NOT NULL,
    actress_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, actress_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_actress_actress_id ON video_actress(actress_id);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS video_tag (
    video_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual', 'scraped')),
    source TEXT,
    created_at TEXT,
    PRIMARY KEY (video_id, tag_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_tag_tag_id ON video_tag(tag_id);
CREATE INDEX IF NOT EXISTS idx_video_tag_origin ON video_tag(origin);

${VIDEO_SOURCES_SCHEMA_SQL}

CREATE TABLE IF NOT EXISTS video_external_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    rating_average REAL,
    rating_count INTEGER,
    fetched_at TEXT,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    UNIQUE (video_id, source)
);

CREATE TABLE IF NOT EXISTS video_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    remote_url TEXT,
    local_path TEXT,
    width INTEGER,
    height INTEGER,
    is_primary INTEGER DEFAULT 0,
    created_at TEXT,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_assets_video_type ON video_assets(video_id, type);

CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    cover_path TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_playlists_created_at ON playlists(created_at);

CREATE TABLE IF NOT EXISTS playlist_video (
    playlist_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    position INTEGER DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (playlist_id, video_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_playlist_video_video_id ON playlist_video(video_id);

CREATE TABLE IF NOT EXISTS actress_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actress_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    locale TEXT,
    source TEXT,
    is_primary INTEGER DEFAULT 0,
    FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE,
    UNIQUE (actress_id, name, type)
);
CREATE INDEX IF NOT EXISTS idx_actress_names_name ON actress_names(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_actress_names_one_main
    ON actress_names(actress_id)
    WHERE type = 'main';

CREATE TABLE IF NOT EXISTS actress_name_ownership (
    normalized_name TEXT PRIMARY KEY CHECK(length(normalized_name) > 0),
    actress_id INTEGER NOT NULL,
    FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_actress_name_ownership_actress_id
    ON actress_name_ownership(actress_id);

CREATE TABLE IF NOT EXISTS pending_actress_name_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    normalized_name TEXT NOT NULL CHECK(length(normalized_name) > 0),
    actress_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    locale TEXT,
    source TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE,
    UNIQUE (normalized_name, actress_id, name, type)
);
CREATE INDEX IF NOT EXISTS idx_pending_actress_name_claims_normalized
    ON pending_actress_name_claims(normalized_name);
CREATE INDEX IF NOT EXISTS idx_pending_actress_name_claims_actress_id
    ON pending_actress_name_claims(actress_id);

CREATE TABLE IF NOT EXISTS pending_actress_scrapes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actress_id INTEGER NOT NULL UNIQUE,
    revision INTEGER NOT NULL DEFAULT 1,
    target_actress_revision INTEGER NOT NULL,
    plugin_name TEXT NOT NULL,
    plugin_source TEXT NOT NULL CHECK(plugin_source IN ('builtin', 'user', 'composite')),
    plugin_version TEXT,
    query_name TEXT NOT NULL,
    selected_fields_json TEXT NOT NULL,
    applicable_fields_json TEXT NOT NULL,
    update_mode TEXT NOT NULL CHECK(update_mode IN ('replace', 'fillEmpty', 'replaceIfPresent')),
    result_json TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    batch_job_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pending_actress_scrapes_created_at
    ON pending_actress_scrapes(created_at);

CREATE TABLE IF NOT EXISTS pending_actress_scrape_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pending_scrape_id INTEGER NOT NULL,
    normalized_name TEXT NOT NULL CHECK(length(normalized_name) > 0),
    name TEXT NOT NULL,
    name_type TEXT NOT NULL CHECK(name_type IN ('main', 'zh', 'en', 'alias')),
    FOREIGN KEY (pending_scrape_id) REFERENCES pending_actress_scrapes(id) ON DELETE CASCADE,
    UNIQUE (pending_scrape_id, normalized_name, name, name_type)
);
CREATE INDEX IF NOT EXISTS idx_pending_actress_scrape_conflicts_name
    ON pending_actress_scrape_conflicts(normalized_name);

CREATE TABLE IF NOT EXISTS pending_actress_scrape_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pending_scrape_id INTEGER NOT NULL,
    field TEXT NOT NULL CHECK(field IN ('avatar', 'gallery')),
    position INTEGER NOT NULL DEFAULT 0,
    remote_url TEXT,
    staged_path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    FOREIGN KEY (pending_scrape_id) REFERENCES pending_actress_scrapes(id) ON DELETE CASCADE,
    UNIQUE (pending_scrape_id, field, position)
);
CREATE INDEX IF NOT EXISTS idx_pending_actress_scrape_resources_pending
    ON pending_actress_scrape_resources(pending_scrape_id);

CREATE TABLE IF NOT EXISTS actress_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source TEXT,
    category TEXT,
    UNIQUE (name, source)
);

CREATE TABLE IF NOT EXISTS actress_tag (
    actress_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (actress_id, tag_id),
    FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES actress_tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_actress_tag_tag_id ON actress_tag(tag_id);

CREATE TABLE IF NOT EXISTS actress_gallery_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actress_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'gallery',
    position INTEGER DEFAULT 0,
    remote_url TEXT,
    local_path TEXT,
    width INTEGER,
    height INTEGER,
    created_at TEXT,
    FOREIGN KEY (actress_id) REFERENCES actresses(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_actress_gallery_assets_actress_id
    ON actress_gallery_assets(actress_id);

${MEDIA_LIBRARY_PENDING_SCAN_SCHEMA_SQL}

${PENDING_VIDEO_SCRAPES_SCHEMA_SQL}

${MEDIA_LIBRARY_SCAN_SCHEMA_SQL}

${RELATED_LINKS_SCHEMA_SQL}

${AGENT_PLATFORM_SCHEMA_SQL}

${AGENT_METADATA_SCHEMA_SQL}

${PLAYLIST_IMPORT_SCHEMA_SQL}
`
