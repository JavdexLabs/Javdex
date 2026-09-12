import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { normalizeLocalPathIdentity } from "@library/localPathIdentity";
import { DEFAULT_SETTINGS } from "@shared/settingsTypes";
import { migrateDatabase } from "@library/db/migrations";
import {
  bootstrapLegacyMediaLibrary,
  LEGACY_CLEANUP_WAITING_ERROR,
  type LegacyMediaLibrarySettings,
} from "./legacyMediaLibraryBootstrap";

function legacySettings(
  overrides: Partial<LegacyMediaLibrarySettings> = {},
): LegacyMediaLibrarySettings {
  return {
    libraryPaths: [],
    pendingLibraryPathCleanups: [],
    autoDeleteResourceLessVideos: false,
    autoScanEnabled: false,
    autoScanIntervalMinutes: 60,
    lastLibraryScanSummary: null,
    unrecognizedFiles: [],
    unrecognizedFilesScanFinishedAt: null,
    minScanImportDurationMinutes: 30,
    autoMergeSameCodeResources: true,
    defaultScraper: "JavDB",
    coverDisplayMode: "portrait",
    ...overrides,
  };
}

function freshDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  migrateDatabase(database);
  return database;
}

describe("legacy media-library settings bootstrap", () => {
  it("keeps native V14 config defaults when a fresh database has no legacy evidence", () => {
    const database = freshDatabase();
    try {
      const result = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () => legacySettings(),
        updateSettings: () => undefined,
      });

      assert.equal(result.imported, true);
      assert.deepEqual(result.settingsCleanup, { status: "completed" });
      assert.deepEqual(
        database
          .prepare(
            `SELECT auto_scan_enabled, auto_scan_interval_minutes,
                    min_import_duration_minutes, auto_merge_same_code_resources,
                    remove_resource_less_memberships, default_video_scraper,
                    legacy_settings_imported_at IS NOT NULL AS imported
             FROM media_library_configs WHERE library_id = 1`,
          )
          .get(),
        {
          auto_scan_enabled: 0,
          auto_scan_interval_minutes: 1440,
          min_import_duration_minutes: 30,
          auto_merge_same_code_resources: 1,
          remove_resource_less_memberships: 0,
          default_video_scraper: null,
          imported: 1,
        },
      );
    } finally {
      database.close();
    }
  });

  it("imports roots, cleanup work, and typed configuration into the default library once", () => {
    const database = freshDatabase();
    const offlineCleanupPath = path.join(
      os.tmpdir(),
      `javdex-legacy-offline-${process.pid}-${Math.random()}`,
    );
    const settings = legacySettings({
      libraryPaths: ["/media/current", "/media/current/"],
      pendingLibraryPathCleanups: [offlineCleanupPath],
      autoDeleteResourceLessVideos: true,
      autoScanEnabled: true,
      autoScanIntervalMinutes: 180,
      minScanImportDurationMinutes: 45,
      autoMergeSameCodeResources: false,
      defaultScraper: "Custom Video",
      coverDisplayMode: "landscape",
    });
    const cleanupPatches: Array<Record<string, unknown>> = [];

    try {
      const first = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () => settings,
        updateSettings: (patch) => {
          cleanupPatches.push(patch);
        },
      });

      assert.deepEqual(first, {
        libraryId: 1,
        imported: true,
        rootsCreated: 2,
        rootsUpdated: 0,
        resourcesLinked: 0,
        cleanupJobsImported: 1,
        scanSummaryImported: false,
        unrecognizedFilesImported: 0,
        settingsCleanup: { status: "completed" },
      });
      assert.deepEqual(
        database
          .prepare(
            `SELECT path, normalized_path, position, state
             FROM media_library_roots
             ORDER BY position, id`,
          )
          .all(),
        [
          {
            path: "/media/current",
            normalized_path: normalizeLocalPathIdentity("/media/current"),
            position: 0,
            state: "active",
          },
          {
            path: offlineCleanupPath,
            normalized_path: normalizeLocalPathIdentity(offlineCleanupPath),
            position: 1,
            state: "disabled",
          },
        ],
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT auto_scan_enabled, auto_scan_interval_minutes,
                    min_import_duration_minutes, auto_merge_same_code_resources,
                    remove_resource_less_memberships, default_video_scraper,
                    legacy_settings_imported_at IS NOT NULL AS imported
             FROM media_library_configs WHERE library_id = 1`,
          )
          .get(),
        {
          auto_scan_enabled: 1,
          auto_scan_interval_minutes: 180,
          min_import_duration_minutes: 45,
          auto_merge_same_code_resources: 0,
          remove_resource_less_memberships: 1,
          default_video_scraper: "Custom Video",
          imported: 1,
        },
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT library_id, root_id, state, root_path, normalized_root_path,
                    normalized_real_path, device_id, inode, config_revision, last_error
             FROM library_root_cleanup_jobs`,
          )
          .get(),
        {
          library_id: 1,
          root_id: 2,
          state: "failed",
          root_path: offlineCleanupPath,
          normalized_root_path: normalizeLocalPathIdentity(offlineCleanupPath),
          normalized_real_path: null,
          device_id: null,
          inode: null,
          config_revision: 1,
          last_error: LEGACY_CLEANUP_WAITING_ERROR,
        },
      );
      assert.deepEqual(cleanupPatches, [
        {
          libraryPaths: [],
          pendingLibraryPathCleanups: [],
          autoDeleteResourceLessVideos:
            DEFAULT_SETTINGS.autoDeleteResourceLessVideos,
          autoScanEnabled: DEFAULT_SETTINGS.autoScanEnabled,
          autoScanIntervalMinutes: DEFAULT_SETTINGS.autoScanIntervalMinutes,
          lastLibraryScanSummary: null,
          unrecognizedFiles: [],
          unrecognizedFilesScanFinishedAt: null,
          minScanImportDurationMinutes:
            DEFAULT_SETTINGS.minScanImportDurationMinutes,
          autoMergeSameCodeResources:
            DEFAULT_SETTINGS.autoMergeSameCodeResources,
        },
      ]);

      const second = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () => legacySettings(),
        updateSettings: () => undefined,
      });
      assert.equal(second.imported, false);
      assert.equal(
        (
          database
            .prepare("SELECT COUNT(*) AS count FROM media_library_roots")
            .get() as {
            count: number;
          }
        ).count,
        2,
      );
      assert.equal(
        (
          database
            .prepare("SELECT COUNT(*) AS count FROM library_root_cleanup_jobs")
            .get() as {
            count: number;
          }
        ).count,
        1,
      );
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally {
      database.close();
    }
  });

  it("freezes an online legacy cleanup root identity before making the work active", () => {
    const database = freshDatabase();
    const onlineCleanupPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "javdex-legacy-online-"),
    );
    try {
      const result = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () =>
          legacySettings({ pendingLibraryPathCleanups: [onlineCleanupPath] }),
        updateSettings: () => undefined,
      });

      assert.equal(result.cleanupJobsImported, 1);
      const root = database
        .prepare(
          `SELECT state, real_path, normalized_real_path, device_id, inode
             FROM media_library_roots WHERE library_id = 1`,
        )
        .get() as {
        state: string;
        real_path: string | null;
        normalized_real_path: string | null;
        device_id: string | null;
        inode: string | null;
      };
      const job = database
        .prepare(
          `SELECT state, normalized_real_path, device_id, inode, last_error
             FROM library_root_cleanup_jobs WHERE library_id = 1`,
        )
        .get();

      assert.equal(root.state, "pending_removal");
      assert.equal(root.real_path, fs.realpathSync.native(onlineCleanupPath));
      assert.ok(root.normalized_real_path);
      assert.ok(root.device_id);
      assert.ok(root.inode);
      assert.deepEqual(job, {
        state: "pending",
        normalized_real_path: root.normalized_real_path,
        device_id: root.device_id,
        inode: root.inode,
        last_error: null,
      });
    } finally {
      database.close();
      fs.rmSync(onlineCleanupPath, { recursive: true, force: true });
    }
  });

  it("keeps parent and child legacy paths but enables only the first non-overlapping set", () => {
    const database = freshDatabase();
    const parentPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "javdex-legacy-overlap-"),
    );
    const childPath = path.join(parentPath, "child");
    const siblingPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "javdex-legacy-sibling-"),
    );
    fs.mkdirSync(childPath);
    const videoId = Number(
      database.prepare("INSERT INTO videos (code) VALUES ('OVERLAP-001')").run()
        .lastInsertRowid,
    );
    database
      .prepare(
        `INSERT INTO library_video_memberships (
           library_id, video_id, added_via, discovery_key
         ) VALUES (1, ?, 'shared', 301)`,
      )
      .run(videoId);
    const resourcePath = path.join(parentPath, "OVERLAP-001.mp4");
    database
      .prepare(
        `INSERT INTO video_resources (
           library_id, video_id, kind, locator, resource_key,
           source_identity, is_primary
         ) VALUES (1, ?, 'local', ?, ?, ?, 1)`,
      )
      .run(
        videoId,
        resourcePath,
        `local:${resourcePath}`,
        `local:${normalizeLocalPathIdentity(resourcePath)}`,
      );
    const settings = legacySettings({
      libraryPaths: [childPath, parentPath, siblingPath],
    });
    try {
      const first = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () => settings,
      });

      assert.equal(first.rootsCreated, 3);
      assert.deepEqual(
        database
          .prepare(
            `SELECT path, state
               FROM media_library_roots
              ORDER BY position, id`,
          )
          .all(),
        [
          { path: childPath, state: "active" },
          { path: parentPath, state: "disabled" },
          { path: siblingPath, state: "active" },
        ],
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT resource.locator, root.path AS root_path, root.state AS root_state
               FROM video_resources resource
               JOIN media_library_roots root ON root.id = resource.root_id
              WHERE resource.video_id = ?`,
          )
          .get(videoId),
        {
          locator: resourcePath,
          root_path: parentPath,
          root_state: "disabled",
        },
      );

      const second = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () => settings,
      });
      assert.equal(second.imported, false);
      assert.deepEqual(
        database
          .prepare(
            `SELECT path, state
               FROM media_library_roots
              ORDER BY position, id`,
          )
          .all(),
        [
          { path: childPath, state: "active" },
          { path: parentPath, state: "disabled" },
          { path: siblingPath, state: "active" },
        ],
      );
    } finally {
      database.close();
      fs.rmSync(parentPath, { recursive: true, force: true });
      fs.rmSync(siblingPath, { recursive: true, force: true });
    }
  });

  it("keeps realpath aliases but enables only one physical legacy root", () => {
    const database = freshDatabase();
    const fixturePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "javdex-legacy-alias-"),
    );
    const realPath = path.join(fixturePath, "real");
    const aliasPath = path.join(fixturePath, "alias");
    fs.mkdirSync(realPath);
    fs.symlinkSync(
      realPath,
      aliasPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      const result = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () =>
          legacySettings({ libraryPaths: [realPath, aliasPath] }),
      });

      assert.equal(result.rootsCreated, 2);
      const roots = database
        .prepare(
          `SELECT path, normalized_real_path, device_id, inode, state
             FROM media_library_roots
            ORDER BY position, id`,
        )
        .all() as Array<{
        path: string;
        normalized_real_path: string;
        device_id: string;
        inode: string;
        state: string;
      }>;
      assert.deepEqual(
        roots.map(({ path: rootPath, state }) => ({ path: rootPath, state })),
        [
          { path: realPath, state: "active" },
          { path: aliasPath, state: "disabled" },
        ],
      );
      assert.equal(roots[0].normalized_real_path, roots[1].normalized_real_path);
      assert.equal(roots[0].device_id, roots[1].device_id);
      assert.equal(roots[0].inode, roots[1].inode);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally {
      database.close();
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });

  it("keeps app-level scraper and cover preferences after import and repeated startup cleanup", () => {
    const database = freshDatabase();
    let persisted = legacySettings({
      libraryPaths: ["/media/current"],
      defaultScraper: "Custom Video",
      coverDisplayMode: "landscape",
    });
    const updateSettings = (patch: Partial<typeof persisted>): void => {
      persisted = { ...persisted, ...patch };
    };
    try {
      const first = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () => persisted,
        updateSettings,
      });
      assert.equal(first.imported, true);
      assert.deepEqual(
        database
          .prepare(
            `SELECT default_video_scraper
             FROM media_library_configs WHERE library_id = 1`,
          )
          .get(),
        {
          default_video_scraper: "Custom Video",
        },
      );
      assert.equal(persisted.defaultScraper, "Custom Video");
      assert.equal(persisted.coverDisplayMode, "landscape");

      const second = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () => persisted,
        updateSettings,
      });
      assert.equal(second.imported, false);
      assert.equal(persisted.defaultScraper, "Custom Video");
      assert.equal(persisted.coverDisplayMode, "landscape");
      assert.deepEqual(
        database
          .prepare(
            `SELECT default_video_scraper
             FROM media_library_configs WHERE library_id = 1`,
          )
          .get(),
        {
          default_video_scraper: "Custom Video",
        },
      );
    } finally {
      database.close();
    }
  });

  it("keeps inferred roots and links source-managed resources to the deepest matching root", () => {
    const database = freshDatabase();
    try {
      const insertRoot = database.prepare(
        `INSERT INTO media_library_roots (
           library_id, path, normalized_path, position, state
         ) VALUES (1, ?, ?, ?, 'disabled')`,
      );
      const broadRootId = Number(
        insertRoot.run("/media", normalizeLocalPathIdentity("/media"), 0)
          .lastInsertRowid,
      );
      const nestedRootId = Number(
        insertRoot.run(
          "/media/nested",
          normalizeLocalPathIdentity("/media/nested"),
          1,
        ).lastInsertRowid,
      );
      const videoId = Number(
        database.prepare("INSERT INTO videos (code) VALUES ('ROOT-001')").run()
          .lastInsertRowid,
      );
      database
        .prepare(
          `INSERT INTO library_video_memberships (
             library_id, video_id, added_via, discovery_key
           ) VALUES (1, ?, 'shared', 91)`,
        )
        .run(videoId);
      const insertResource = database.prepare(
        `INSERT INTO video_resources (
           library_id, video_id, kind, locator, resource_key, source_identity,
           strm_source_path, is_primary
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertResource.run(
        videoId,
        "local",
        "/media/nested/ROOT-001.mp4",
        "local:/media/nested/ROOT-001.mp4",
        `local:${normalizeLocalPathIdentity("/media/nested/ROOT-001.mp4")}`,
        null,
        1,
      );
      insertResource.run(
        videoId,
        "web",
        "https://example.test/watch/root-001",
        "strm:/media/ROOT-001.strm",
        `strm:${normalizeLocalPathIdentity("/media/ROOT-001.strm")}`,
        "/media/ROOT-001.strm",
        0,
      );
      insertResource.run(
        videoId,
        "local",
        "/outside/ROOT-001.mp4",
        "local:/outside/ROOT-001.mp4",
        `local:${normalizeLocalPathIdentity("/outside/ROOT-001.mp4")}`,
        null,
        0,
      );
      insertResource.run(
        videoId,
        "direct",
        "https://cdn.example/ROOT-001.mp4",
        "http:https://cdn.example/ROOT-001.mp4",
        null,
        null,
        0,
      );

      const result = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () => legacySettings({ libraryPaths: ["/media"] }),
      });

      assert.equal(result.rootsCreated, 0);
      assert.equal(result.rootsUpdated, 1);
      assert.equal(result.resourcesLinked, 2);
      assert.deepEqual(result.settingsCleanup, { status: "skipped" });
      assert.deepEqual(
        database
          .prepare(
            `SELECT locator, root_id
             FROM video_resources
             ORDER BY id`,
          )
          .all(),
        [
          { locator: "/media/nested/ROOT-001.mp4", root_id: nestedRootId },
          {
            locator: "https://example.test/watch/root-001",
            root_id: broadRootId,
          },
          { locator: "/outside/ROOT-001.mp4", root_id: null },
          { locator: "https://cdn.example/ROOT-001.mp4", root_id: null },
        ],
      );
      assert.deepEqual(
        database
          .prepare("SELECT id, state FROM media_library_roots ORDER BY id")
          .all(),
        [
          { id: broadRootId, state: "active" },
          { id: nestedRootId, state: "disabled" },
        ],
      );
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally {
      database.close();
    }
  });

  it("imports the last scan summary and its managed unrecognized-file snapshot", () => {
    const database = freshDatabase();
    const summary = {
      libraryId: 1,
      runId: "legacy-summary",
      configRevision: 1,
      trigger: "interval" as const,
      startedAt: "2026-08-20T01:00:00.000Z",
      finishedAt: "2026-08-20T01:02:00.000Z",
      status: "completed_with_errors" as const,
      scannedFiles: 12,
      resourcesAdded: 2,
      resourcesUpdated: 1,
      resourcesRemoved: 0,
      primaryResourcesPromoted: 0,
      videosDeleted: 0,
      skippedFiles: 8,
      failedFiles: 1,
      pendingScanGroups: 1,
      pendingScanResources: 1,
      offlineFolders: [],
      errorSummary: "一个文件处理失败",
    };
    try {
      const result = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () =>
          legacySettings({
            libraryPaths: ["/media"],
            lastLibraryScanSummary: summary,
            unrecognizedFiles: [
              "/media/UNKNOWN.mp4",
              "/media/nested/../UNKNOWN.mp4",
              "/outside/UNMANAGED.mp4",
            ],
            unrecognizedFilesScanFinishedAt: summary.finishedAt,
          }),
      });

      assert.equal(result.scanSummaryImported, true);
      assert.equal(result.unrecognizedFilesImported, 1);
      const scanRun = database
        .prepare(
          `SELECT id, library_id, config_revision, trigger, status,
                  started_at, finished_at, summary_json, audit_json, error_summary
           FROM library_scan_runs`,
        )
        .get() as {
        id: string;
        library_id: number;
        config_revision: number;
        trigger: string;
        status: string;
        started_at: string;
        finished_at: string;
        summary_json: string;
        audit_json: string | null;
        error_summary: string | null;
      };
      assert.deepEqual(
        {
          library_id: scanRun.library_id,
          config_revision: scanRun.config_revision,
          trigger: scanRun.trigger,
          status: scanRun.status,
          started_at: scanRun.started_at,
          finished_at: scanRun.finished_at,
          summary: JSON.parse(scanRun.summary_json),
          audit_json: scanRun.audit_json,
          error_summary: scanRun.error_summary,
        },
        {
          library_id: 1,
          config_revision: 1,
          trigger: "automatic",
          status: "completed",
          started_at: summary.startedAt,
          finished_at: summary.finishedAt,
          summary,
          audit_json: null,
          error_summary: summary.errorSummary,
        },
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT last_status, last_started_at, last_finished_at,
                    last_successful_at, last_summary_json, last_error
             FROM media_library_scan_state WHERE library_id = 1`,
          )
          .get(),
        {
          last_status: "completed",
          last_started_at: summary.startedAt,
          last_finished_at: summary.finishedAt,
          last_successful_at: summary.finishedAt,
          last_summary_json: JSON.stringify(summary),
          last_error: summary.errorSummary,
        },
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT file_path, normalized_path, reason, scan_run_id, last_seen_at
             FROM library_unrecognized_files`,
          )
          .get(),
        {
          file_path: "/media/UNKNOWN.mp4",
          normalized_path: normalizeLocalPathIdentity("/media/UNKNOWN.mp4"),
          reason: null,
          scan_run_id: scanRun.id,
          last_seen_at: summary.finishedAt,
        },
      );
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally {
      database.close();
    }
  });

  it("preserves a standalone unrecognized snapshot through a synthetic legacy scan run", () => {
    const database = freshDatabase();
    const snapshotFinishedAt = "2026-08-21T02:03:04.000Z";
    try {
      const rootId = Number(
        database
          .prepare(
            `INSERT INTO media_library_roots (
               library_id, path, normalized_path, position, state
             ) VALUES (1, '/offline', ?, 0, 'disabled')`,
          )
          .run(normalizeLocalPathIdentity("/offline")).lastInsertRowid,
      );

      const result = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () =>
          legacySettings({
            unrecognizedFiles: ["/offline/UNKNOWN.mp4"],
            unrecognizedFilesScanFinishedAt: snapshotFinishedAt,
          }),
      });

      assert.equal(result.scanSummaryImported, false);
      assert.equal(result.unrecognizedFilesImported, 1);
      assert.deepEqual(
        database
          .prepare(
            `SELECT trigger, status, started_at, finished_at, summary_json
             FROM library_scan_runs`,
          )
          .get(),
        {
          trigger: "initial",
          status: "completed",
          started_at: snapshotFinishedAt,
          finished_at: snapshotFinishedAt,
          summary_json: null,
        },
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT root_id, file_path, last_seen_at
             FROM library_unrecognized_files`,
          )
          .get(),
        {
          root_id: rootId,
          file_path: "/offline/UNKNOWN.mp4",
          last_seen_at: snapshotFinishedAt,
        },
      );
    } finally {
      database.close();
    }
  });

  it("keeps an older safe snapshot separate from a newer failed scan summary", () => {
    const database = freshDatabase();
    const snapshotFinishedAt = "2026-08-21T02:03:04.000Z";
    const failedSummary = {
      libraryId: 1,
      runId: "legacy-failed-summary",
      configRevision: 1,
      trigger: "manual" as const,
      startedAt: "2026-08-22T03:00:00.000Z",
      finishedAt: "2026-08-22T03:01:00.000Z",
      status: "failed" as const,
      scannedFiles: 1,
      resourcesAdded: 0,
      resourcesUpdated: 0,
      resourcesRemoved: 0,
      primaryResourcesPromoted: 0,
      videosDeleted: 0,
      skippedFiles: 0,
      failedFiles: 1,
      pendingScanGroups: 0,
      pendingScanResources: 0,
      offlineFolders: [],
      errorSummary: "扫描根不可访问",
    };
    try {
      bootstrapLegacyMediaLibrary({
        database,
        readSettings: () =>
          legacySettings({
            libraryPaths: ["/media"],
            lastLibraryScanSummary: failedSummary,
            unrecognizedFiles: ["/media/UNKNOWN.mp4"],
            unrecognizedFilesScanFinishedAt: snapshotFinishedAt,
          }),
      });

      assert.deepEqual(
        database
          .prepare(
            `SELECT status, finished_at, summary_json
             FROM library_scan_runs
             ORDER BY finished_at`,
          )
          .all(),
        [
          {
            status: "completed",
            finished_at: snapshotFinishedAt,
            summary_json: null,
          },
          {
            status: "failed",
            finished_at: failedSummary.finishedAt,
            summary_json: JSON.stringify(failedSummary),
          },
        ],
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT scan.status, snapshot.last_seen_at
             FROM library_unrecognized_files snapshot
             JOIN library_scan_runs scan ON scan.id = snapshot.scan_run_id`,
          )
          .get(),
        { status: "completed", last_seen_at: snapshotFinishedAt },
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT last_status, last_finished_at, last_successful_at
             FROM media_library_scan_state WHERE library_id = 1`,
          )
          .get(),
        {
          last_status: "failed",
          last_finished_at: failedSummary.finishedAt,
          last_successful_at: snapshotFinishedAt,
        },
      );
    } finally {
      database.close();
    }
  });

  it("retries JSON cleanup without importing database rows twice", () => {
    const database = freshDatabase();
    const settings = legacySettings({
      libraryPaths: ["/media/current"],
      pendingLibraryPathCleanups: ["/media/retired"],
    });
    let retryCleanupCalled = false;
    try {
      const first = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () => settings,
        updateSettings: () => {
          throw new Error("settings disk is full");
        },
      });
      assert.deepEqual(first.settingsCleanup, {
        status: "failed",
        error: "settings disk is full",
      });
      assert.equal(first.imported, true);

      const second = bootstrapLegacyMediaLibrary({
        database,
        readSettings: () => settings,
        updateSettings: () => {
          retryCleanupCalled = true;
        },
      });
      assert.equal(retryCleanupCalled, true);
      assert.deepEqual(second, {
        libraryId: 1,
        imported: false,
        rootsCreated: 0,
        rootsUpdated: 0,
        resourcesLinked: 0,
        cleanupJobsImported: 0,
        scanSummaryImported: false,
        unrecognizedFilesImported: 0,
        settingsCleanup: { status: "completed" },
      });
      assert.equal(
        (
          database
            .prepare("SELECT COUNT(*) AS count FROM media_library_roots")
            .get() as {
            count: number;
          }
        ).count,
        2,
      );
      assert.equal(
        (
          database
            .prepare("SELECT COUNT(*) AS count FROM library_root_cleanup_jobs")
            .get() as {
            count: number;
          }
        ).count,
        1,
      );
    } finally {
      database.close();
    }
  });

  it("rolls back every database change and skips JSON cleanup when import fails", () => {
    const database = freshDatabase();
    let cleanupCalled = false;
    try {
      database.exec(`
        CREATE TRIGGER fail_legacy_cleanup_job
        BEFORE INSERT ON library_root_cleanup_jobs
        BEGIN
          SELECT RAISE(ABORT, 'forced bootstrap rollback');
        END;
      `);

      assert.throws(
        () =>
          bootstrapLegacyMediaLibrary({
            database,
            readSettings: () =>
              legacySettings({
                libraryPaths: ["/media/current"],
                pendingLibraryPathCleanups: ["/media/retired"],
                autoScanEnabled: true,
              }),
            updateSettings: () => {
              cleanupCalled = true;
            },
          }),
        /forced bootstrap rollback/,
      );

      assert.equal(cleanupCalled, false);
      assert.equal(
        (
          database
            .prepare("SELECT COUNT(*) AS count FROM media_library_roots")
            .get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(
        (
          database
            .prepare("SELECT COUNT(*) AS count FROM library_root_cleanup_jobs")
            .get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT auto_scan_enabled, legacy_settings_imported_at
             FROM media_library_configs WHERE library_id = 1`,
          )
          .get(),
        { auto_scan_enabled: 0, legacy_settings_imported_at: null },
      );
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally {
      database.close();
    }
  });
});
