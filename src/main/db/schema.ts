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

export const PENDING_VIDEO_DECISIONS_SCHEMA_SQL = `
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

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

${CLASSIFICATION_V8_SCHEMA_SQL}

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

CREATE TABLE IF NOT EXISTS video_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('local', 'direct', 'web', 'magnet', 'ed2k')),
    locator TEXT NOT NULL,
    resource_key TEXT NOT NULL UNIQUE,
    strm_source_path TEXT,
    size_bytes INTEGER,
    duration_seconds INTEGER,
    file_mtime_ms INTEGER,
    display_name TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_resources_video_id ON video_resources(video_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_resources_key ON video_resources(resource_key);
CREATE INDEX IF NOT EXISTS idx_video_resources_primary ON video_resources(video_id, is_primary);
CREATE INDEX IF NOT EXISTS idx_video_resources_kind ON video_resources(kind);
CREATE INDEX IF NOT EXISTS idx_video_resources_strm_source_path
    ON video_resources(strm_source_path);

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

${PENDING_VIDEO_DECISIONS_SCHEMA_SQL}

${RELATED_LINKS_SCHEMA_SQL}

${AGENT_PLATFORM_SCHEMA_SQL}

${AGENT_METADATA_SCHEMA_SQL}
`
