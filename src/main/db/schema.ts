// SQLite schema. Executed on startup (idempotent via IF NOT EXISTS).

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    title TEXT,
    summary TEXT,
    cover_path TEXT,
    poster_path TEXT,
    original_title TEXT,
    rating INTEGER DEFAULT 0,
    release_date TEXT,
    maker TEXT,
    publisher TEXT,
    series TEXT,
    director TEXT,
    duration_seconds INTEGER,
    scraped_status INTEGER DEFAULT 0,
    last_scraped_at TEXT,
    updated_at TEXT,
    add_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_videos_code ON videos(code);
CREATE INDEX IF NOT EXISTS idx_videos_add_time ON videos(add_time);
CREATE INDEX IF NOT EXISTS idx_videos_release_date ON videos(release_date);
CREATE INDEX IF NOT EXISTS idx_videos_rating ON videos(rating);
CREATE INDEX IF NOT EXISTS idx_videos_scraped_status ON videos(scraped_status);
CREATE INDEX IF NOT EXISTS idx_videos_maker ON videos(maker);
CREATE INDEX IF NOT EXISTS idx_videos_publisher ON videos(publisher);
CREATE INDEX IF NOT EXISTS idx_videos_series ON videos(series);
CREATE INDEX IF NOT EXISTS idx_videos_director ON videos(director);

CREATE TABLE IF NOT EXISTS video_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    file_size INTEGER,
    file_duration_seconds INTEGER,
    file_mtime_ms INTEGER,
    label TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_files_video_id ON video_files(video_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_files_file_path ON video_files(file_path);
CREATE INDEX IF NOT EXISTS idx_video_files_primary ON video_files(video_id, is_primary);

CREATE TABLE IF NOT EXISTS actresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    main_name TEXT UNIQUE NOT NULL,
    avatar_path TEXT,
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
    last_scraped_at TEXT,
    updated_at TEXT,
    gender TEXT CHECK(gender IN ('female', 'male'))
);

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

-- Registry of known facet values (maker / publisher / series / director). Keeps entries
-- visible after all linked videos lose that field, so they can be deleted.
CREATE TABLE IF NOT EXISTS facet_entries (
    type TEXT NOT NULL CHECK(type IN ('maker', 'publisher', 'series', 'director')),
    value TEXT NOT NULL,
    PRIMARY KEY (type, value)
);

CREATE TABLE IF NOT EXISTS video_external_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT,
    external_code TEXT,
    url TEXT,
    title TEXT,
    fetched_at TEXT,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    UNIQUE (video_id, source)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_external_source_id
    ON video_external_ids(source, external_id)
    WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_video_external_video_id ON video_external_ids(video_id);

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
`
