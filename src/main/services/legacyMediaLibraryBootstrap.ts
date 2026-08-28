import type Database from "better-sqlite3";
import path from "node:path";
import {
  LEGACY_CLEANUP_JOB_ID_PREFIX,
  LEGACY_CLEANUP_WAITING_ERROR,
} from "@shared/legacyLibraryCleanup";
import { normalizeLocalPathIdentity } from "@shared/localPathIdentity";
import {
  mediaLibraryRootIdentitiesOverlap,
  resolveMediaLibraryRootIdentity,
  type ResolvedMediaLibraryRootPath,
} from "@shared/mediaLibraryRootPath";
import { DEFAULT_SETTINGS, type AppSettings } from "@shared/settingsTypes";

export {
  LEGACY_CLEANUP_JOB_ID_PREFIX,
  LEGACY_CLEANUP_WAITING_ERROR,
} from "@shared/legacyLibraryCleanup";

export type LegacyMediaLibrarySettings = Pick<
  AppSettings,
  | "libraryPaths"
  | "pendingLibraryPathCleanups"
  | "autoDeleteResourceLessVideos"
  | "autoScanEnabled"
  | "autoScanIntervalMinutes"
  | "lastLibraryScanSummary"
  | "unrecognizedFiles"
  | "unrecognizedFilesScanFinishedAt"
  | "minScanImportDurationMinutes"
  | "autoMergeSameCodeResources"
  | "defaultScraper"
  | "coverDisplayMode"
>;

export interface LegacyMediaLibraryBootstrapDependencies {
  database: Database.Database;
  readSettings: () => LegacyMediaLibrarySettings;
  updateSettings?: (patch: Partial<AppSettings>) => unknown;
}

export type LegacySettingsCleanupResult =
  | { status: "completed" }
  | { status: "skipped" }
  | { status: "failed"; error: string };

export interface LegacyMediaLibraryBootstrapResult {
  libraryId: number;
  imported: boolean;
  rootsCreated: number;
  rootsUpdated: number;
  resourcesLinked: number;
  cleanupJobsImported: number;
  scanSummaryImported: boolean;
  unrecognizedFilesImported: number;
  settingsCleanup: LegacySettingsCleanupResult;
}

interface RootRow {
  id: number;
  path: string;
  normalized_path: string;
  real_path: string | null;
  normalized_real_path: string | null;
  device_id: string | null;
  inode: string | null;
  position: number;
  state: "active" | "pending_removal" | "disabled" | "archived";
}

interface ImportedDatabaseState {
  libraryId: number;
  imported: boolean;
  rootsCreated: number;
  rootsUpdated: number;
  resourcesLinked: number;
  cleanupJobsImported: number;
  scanSummaryImported: boolean;
  unrecognizedFilesImported: number;
}

const LEGACY_SETTINGS_CLEANUP_PATCH: Partial<AppSettings> = {
  libraryPaths: [],
  pendingLibraryPathCleanups: [],
  autoDeleteResourceLessVideos: DEFAULT_SETTINGS.autoDeleteResourceLessVideos,
  autoScanEnabled: DEFAULT_SETTINGS.autoScanEnabled,
  autoScanIntervalMinutes: DEFAULT_SETTINGS.autoScanIntervalMinutes,
  lastLibraryScanSummary: null,
  unrecognizedFiles: [],
  unrecognizedFilesScanFinishedAt: null,
  minScanImportDurationMinutes: DEFAULT_SETTINGS.minScanImportDurationMinutes,
  autoMergeSameCodeResources: DEFAULT_SETTINGS.autoMergeSameCodeResources,
};

function normalizedPaths(
  paths: string[],
): Array<{ path: string; normalizedPath: string }> {
  const byIdentity = new Map<string, string>();
  for (const candidate of paths) {
    const path = candidate.trim();
    if (!path) continue;
    const normalizedPath = normalizeLocalPathIdentity(path);
    if (!byIdentity.has(normalizedPath)) byIdentity.set(normalizedPath, path);
  }
  return [...byIdentity].map(([normalizedPath, path]) => ({
    path,
    normalizedPath,
  }));
}

function resolveLegacyRootIdentity(root: {
  path: string;
  normalizedPath: string;
}): Pick<
  RootRow,
  "real_path" | "normalized_real_path" | "device_id" | "inode"
> {
  try {
    const resolved = resolveMediaLibraryRootIdentity(root.path);
    return {
      real_path: resolved.realPath,
      normalized_real_path: resolved.normalizedRealPath,
      device_id: resolved.deviceId,
      inode: resolved.inode,
    };
  } catch {
    // Invalid or temporarily unreadable legacy paths must not abort the one-time
    // settings import. Their lexical identity still preserves the cleanup intent.
    return {
      real_path: null,
      normalized_real_path: null,
      device_id: null,
      inode: null,
    };
  }
}

function hasPhysicalRootIdentity(
  root: Pick<
    RootRow,
    "normalized_real_path" | "device_id" | "inode"
  >,
): boolean {
  return Boolean(root.normalized_real_path && root.device_id && root.inode);
}

function storedPhysicalIdentityMatches(
  stored: Pick<RootRow, "normalized_real_path" | "device_id" | "inode">,
  current: Pick<RootRow, "normalized_real_path" | "device_id" | "inode">,
): boolean {
  return (
    (!stored.normalized_real_path ||
      stored.normalized_real_path === current.normalized_real_path) &&
    (!stored.device_id || stored.device_id === current.device_id) &&
    (!stored.inode || stored.inode === current.inode)
  );
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function mapLegacyScanTrigger(
  trigger: NonNullable<
    LegacyMediaLibrarySettings["lastLibraryScanSummary"]
  >["trigger"],
): "manual" | "automatic" | "initial" {
  if (trigger === "manual") return "manual";
  if (trigger === "startup") return "initial";
  return "automatic";
}

function mapLegacyScanStatus(
  status: NonNullable<
    LegacyMediaLibrarySettings["lastLibraryScanSummary"]
  >["status"],
): "completed" | "failed" | "cancelled" {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "completed";
}

function hasLegacySettingEvidence(
  settings: LegacyMediaLibrarySettings,
): boolean {
  return (
    settings.libraryPaths.length > 0 ||
    settings.pendingLibraryPathCleanups.length > 0 ||
    settings.lastLibraryScanSummary != null ||
    settings.unrecognizedFiles.length > 0 ||
    settings.autoDeleteResourceLessVideos !==
      DEFAULT_SETTINGS.autoDeleteResourceLessVideos ||
    settings.autoScanEnabled !== DEFAULT_SETTINGS.autoScanEnabled ||
    settings.autoScanIntervalMinutes !==
      DEFAULT_SETTINGS.autoScanIntervalMinutes ||
    settings.minScanImportDurationMinutes !==
      DEFAULT_SETTINGS.minScanImportDurationMinutes ||
    settings.autoMergeSameCodeResources !==
      DEFAULT_SETTINGS.autoMergeSameCodeResources ||
    settings.defaultScraper !== DEFAULT_SETTINGS.defaultScraper ||
    settings.coverDisplayMode !== DEFAULT_SETTINGS.coverDisplayMode
  );
}

function cleanupLegacySettings(
  updateSettings: LegacyMediaLibraryBootstrapDependencies["updateSettings"],
): LegacySettingsCleanupResult {
  if (!updateSettings) return { status: "skipped" };
  try {
    updateSettings(LEGACY_SETTINGS_CLEANUP_PATCH);
    return { status: "completed" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function importLegacySettings(
  database: Database.Database,
  settings: LegacyMediaLibrarySettings,
): ImportedDatabaseState {
  const defaultLibrary = database
    .prepare("SELECT id FROM media_libraries WHERE is_default = 1")
    .get() as { id: number } | undefined;
  if (!defaultLibrary) throw new Error("Default media library is unavailable");

  database
    .prepare(
      "INSERT OR IGNORE INTO media_library_configs (library_id) VALUES (?)",
    )
    .run(defaultLibrary.id);
  const config = database
    .prepare(
      `SELECT revision, legacy_settings_imported_at
       FROM media_library_configs WHERE library_id = ?`,
    )
    .get(defaultLibrary.id) as {
    revision: number;
    legacy_settings_imported_at: string | null;
  };
  if (config.legacy_settings_imported_at) {
    return {
      libraryId: defaultLibrary.id,
      imported: false,
      rootsCreated: 0,
      rootsUpdated: 0,
      resourcesLinked: 0,
      cleanupJobsImported: 0,
      scanSummaryImported: false,
      unrecognizedFilesImported: 0,
    };
  }

  const existingRoots = database
    .prepare(
      `SELECT id, path, normalized_path, real_path, normalized_real_path,
              device_id, inode, position, state
       FROM media_library_roots
       WHERE library_id = ?
       ORDER BY position, id`,
    )
    .all(defaultLibrary.id) as RootRow[];
  const hasCatalogEvidence = Boolean(
    (
      database
        .prepare(
          `SELECT
             EXISTS(SELECT 1 FROM videos) OR
             EXISTS(
               SELECT 1 FROM library_video_memberships WHERE library_id = ?
             ) OR
             EXISTS(SELECT 1 FROM video_resources WHERE library_id = ?) OR
             EXISTS(SELECT 1 FROM pending_scan_groups WHERE library_id = ?) OR
             EXISTS(SELECT 1 FROM pending_scan_resources WHERE library_id = ?)
             AS present`,
        )
        .get(
          defaultLibrary.id,
          defaultLibrary.id,
          defaultLibrary.id,
          defaultLibrary.id,
        ) as { present: 0 | 1 }
    ).present,
  );
  const hasLegacyEvidence =
    existingRoots.length > 0 ||
    hasCatalogEvidence ||
    hasLegacySettingEvidence(settings);
  const rootByIdentity = new Map(
    existingRoots.map((root) => [root.normalized_path, root]),
  );
  const configuredPaths = normalizedPaths(settings.libraryPaths);
  const cleanupPaths = normalizedPaths(settings.pendingLibraryPathCleanups);
  const cleanupIdentities = new Set(
    cleanupPaths.map((root) => root.normalizedPath),
  );
  const desiredRoots = new Map<
    string,
    {
      path: string;
      normalizedPath: string;
      real_path: string | null;
      normalized_real_path: string | null;
      device_id: string | null;
      inode: string | null;
      state: "active" | "pending_removal" | "disabled" | "archived";
    }
  >();

  for (const root of configuredPaths) {
    desiredRoots.set(root.normalizedPath, {
      ...root,
      ...resolveLegacyRootIdentity(root),
      state: "active",
    });
  }
  for (const root of cleanupPaths) {
    const identity = resolveLegacyRootIdentity(root);
    desiredRoots.set(root.normalizedPath, {
      ...root,
      ...identity,
      // An offline legacy path has no trustworthy physical identity yet. Keep
      // it disabled until a later full scan can bind and recover the intent.
      state: hasPhysicalRootIdentity(identity) ? "pending_removal" : "disabled",
    });
  }
  for (const root of existingRoots) {
    if (!desiredRoots.has(root.normalized_path)) {
      desiredRoots.set(root.normalized_path, {
        path: root.path,
        normalizedPath: root.normalized_path,
        real_path: root.real_path,
        normalized_real_path: root.normalized_real_path,
        device_id: root.device_id,
        inode: root.inode,
        state: root.state,
      });
    }
  }

  const insertRoot = database.prepare(
    `INSERT INTO media_library_roots (
       library_id, path, normalized_path, real_path, normalized_real_path,
       device_id, inode, position, state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRoot = database.prepare(
    `UPDATE media_library_roots
     SET path = ?, real_path = ?, normalized_real_path = ?, device_id = ?,
         inode = ?, position = ?, state = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  );
  const preparedRoots = [...desiredRoots.values()].map((desired) => {
    const existing = rootByIdentity.get(desired.normalizedPath);
    const currentIdentityMatches =
      !existing || storedPhysicalIdentityMatches(existing, desired);
    const identity = {
      real_path: currentIdentityMatches
        ? (desired.real_path ?? existing?.real_path ?? null)
        : (existing?.real_path ?? null),
      normalized_real_path: currentIdentityMatches
        ? (desired.normalized_real_path ??
          existing?.normalized_real_path ??
          null)
        : (existing?.normalized_real_path ?? null),
      device_id: currentIdentityMatches
        ? (desired.device_id ?? existing?.device_id ?? null)
        : (existing?.device_id ?? null),
      inode: currentIdentityMatches
        ? (desired.inode ?? existing?.inode ?? null)
        : (existing?.inode ?? null),
    };
    const state = cleanupIdentities.has(desired.normalizedPath)
      ? hasPhysicalRootIdentity(desired) && currentIdentityMatches
        ? "pending_removal"
        : "disabled"
      : desired.state;
    return { desired, existing, identity, state };
  });
  const selectedManagedRoots = (
    database
      .prepare(
        `SELECT root.id, root.path, root.normalized_path, root.real_path,
                root.normalized_real_path, root.device_id, root.inode,
                root.position, root.state
           FROM media_library_roots root
           JOIN media_libraries library ON library.id = root.library_id
          WHERE root.library_id != ?
            AND root.state IN ('active', 'pending_removal')
            AND library.status = 'active'
          ORDER BY library.position, library.id, root.position, root.id`,
      )
      .all(defaultLibrary.id) as RootRow[]
  ).map(
    (root): ResolvedMediaLibraryRootPath => ({
      path: root.path,
      normalizedPath: root.normalized_path,
      realPath: root.real_path,
      normalizedRealPath: root.normalized_real_path,
      deviceId: root.device_id,
      inode: root.inode,
    }),
  );
  for (const prepared of preparedRoots) {
    if (prepared.state !== "active" && prepared.state !== "pending_removal") {
      continue;
    }
    const candidate: ResolvedMediaLibraryRootPath = {
      path: prepared.desired.path,
      normalizedPath: prepared.desired.normalizedPath,
      realPath: prepared.identity.real_path,
      normalizedRealPath: prepared.identity.normalized_real_path,
      deviceId: prepared.identity.device_id,
      inode: prepared.identity.inode,
    };
    if (
      selectedManagedRoots.some((selected) =>
        mediaLibraryRootIdentitiesOverlap(selected, candidate),
      )
    ) {
      prepared.state = "disabled";
    } else {
      selectedManagedRoots.push(candidate);
    }
  }

  // Release any managed unique identity before a selected replacement is
  // inserted. This keeps a partially upgraded database deterministic even
  // when an inferred existing root physically aliases a legacy setting.
  for (const prepared of preparedRoots) {
    if (
      prepared.existing &&
      prepared.state === "disabled" &&
      (prepared.existing.state === "active" ||
        prepared.existing.state === "pending_removal")
    ) {
      database
        .prepare(
          `UPDATE media_library_roots
              SET state = 'disabled', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
        )
        .run(prepared.existing.id);
    }
  }

  let rootsCreated = 0;
  let rootsUpdated = 0;
  let position = 0;
  for (const { desired, existing, identity, state } of preparedRoots) {
    if (!existing) {
      const id = Number(
        insertRoot.run(
          defaultLibrary.id,
          desired.path,
          desired.normalizedPath,
          identity.real_path,
          identity.normalized_real_path,
          identity.device_id,
          identity.inode,
          position,
          state,
        ).lastInsertRowid,
      );
      const created: RootRow = {
        id,
        path: desired.path,
        normalized_path: desired.normalizedPath,
        ...identity,
        position,
        state,
      };
      rootByIdentity.set(created.normalized_path, created);
      rootsCreated += 1;
    } else if (
      existing.path !== desired.path ||
      existing.real_path !== identity.real_path ||
      existing.normalized_real_path !== identity.normalized_real_path ||
      existing.device_id !== identity.device_id ||
      existing.inode !== identity.inode ||
      existing.position !== position ||
      existing.state !== state
    ) {
      updateRoot.run(
        desired.path,
        identity.real_path,
        identity.normalized_real_path,
        identity.device_id,
        identity.inode,
        position,
        state,
        existing.id,
      );
      existing.path = desired.path;
      existing.real_path = identity.real_path;
      existing.normalized_real_path = identity.normalized_real_path;
      existing.device_id = identity.device_id;
      existing.inode = identity.inode;
      existing.position = position;
      existing.state = state;
      rootsUpdated += 1;
    }
    position += 1;
  }

  if (hasLegacyEvidence) {
    database
      .prepare(
        `UPDATE media_library_configs
         SET auto_scan_enabled = ?,
             auto_scan_interval_minutes = ?,
             min_import_duration_minutes = ?,
             auto_merge_same_code_resources = ?,
             remove_resource_less_memberships = ?,
             default_video_scraper = ?,
             default_cover_mode = ?,
             legacy_settings_imported_at = CURRENT_TIMESTAMP
         WHERE library_id = ?`,
      )
      .run(
        settings.autoScanEnabled ? 1 : 0,
        settings.autoScanIntervalMinutes,
        settings.minScanImportDurationMinutes,
        settings.autoMergeSameCodeResources ? 1 : 0,
        settings.autoDeleteResourceLessVideos ? 1 : 0,
        settings.defaultScraper.trim() || null,
        settings.coverDisplayMode === "landscape" ? "cover" : "poster",
        defaultLibrary.id,
      );
  } else {
    database
      .prepare(
        `UPDATE media_library_configs
         SET legacy_settings_imported_at = CURRENT_TIMESTAMP
         WHERE library_id = ?`,
      )
      .run(defaultLibrary.id);
  }

  const rootsByDepth = [...rootByIdentity.values()]
    .filter((root) => root.state !== "archived")
    .sort(
      (left, right) =>
        right.normalized_path.length - left.normalized_path.length ||
        right.id - left.id,
    );
  const findRoot = (sourcePath: string): RootRow | undefined => {
    const sourceIdentity = normalizeLocalPathIdentity(sourcePath);
    return rootsByDepth.find((candidate) =>
      isPathInsideRoot(sourceIdentity, candidate.normalized_path),
    );
  };
  const resources = database
    .prepare(
      `SELECT id, kind, locator, strm_source_path
       FROM video_resources
       WHERE library_id = ? AND root_id IS NULL
       ORDER BY id`,
    )
    .all(defaultLibrary.id) as Array<{
    id: number;
    kind: string;
    locator: string;
    strm_source_path: string | null;
  }>;
  const linkResource = database.prepare(
    `UPDATE video_resources
     SET root_id = ?
     WHERE id = ? AND library_id = ? AND root_id IS NULL`,
  );
  let resourcesLinked = 0;
  for (const resource of resources) {
    const sourcePath =
      resource.kind === "local" ? resource.locator : resource.strm_source_path;
    if (!sourcePath) continue;
    const root = findRoot(sourcePath);
    if (!root) continue;
    resourcesLinked += linkResource.run(
      root.id,
      resource.id,
      defaultLibrary.id,
    ).changes;
  }

  const unrecognizedByIdentity = new Map<
    string,
    { filePath: string; normalizedPath: string; root: RootRow }
  >();
  for (const candidate of settings.unrecognizedFiles) {
    const filePath = candidate.trim();
    if (!filePath) continue;
    const normalizedPath = normalizeLocalPathIdentity(filePath);
    if (unrecognizedByIdentity.has(normalizedPath)) continue;
    const root = findRoot(filePath);
    if (!root) continue;
    unrecognizedByIdentity.set(normalizedPath, {
      filePath,
      normalizedPath,
      root,
    });
  }

  const summary = settings.lastLibraryScanSummary;
  let scanSummaryImported = false;
  let unrecognizedFilesImported = 0;
  if (summary || unrecognizedByIdentity.size > 0) {
    const fallbackTimestamp = (
      database.prepare("SELECT CURRENT_TIMESTAMP AS now").get() as {
        now: string;
      }
    ).now;
    const insertScanRun = database.prepare(
      `INSERT INTO library_scan_runs (
         id, library_id, config_revision, trigger, status, started_at,
         finished_at, summary_json, audit_json, error_summary
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    const summarySuccessful =
      summary != null &&
      ["success", "completed_with_errors"].includes(summary.status);
    const summaryRunId = summary
      ? `legacy-settings-scan-summary:${defaultLibrary.id}`
      : null;
    const summaryStatus = summary ? mapLegacyScanStatus(summary.status) : null;
    const summaryJson = summary ? JSON.stringify(summary) : null;
    if (summary && summaryRunId && summaryStatus) {
      insertScanRun.run(
        summaryRunId,
        defaultLibrary.id,
        config.revision,
        mapLegacyScanTrigger(summary.trigger),
        summaryStatus,
        summary.startedAt,
        summary.finishedAt,
        summaryJson,
        summary.errorSummary,
      );
      scanSummaryImported = true;
    }

    const snapshotFinishedAt =
      settings.unrecognizedFilesScanFinishedAt ??
      (summarySuccessful ? summary?.finishedAt : null) ??
      fallbackTimestamp;
    const snapshotSharesSummaryRun =
      unrecognizedByIdentity.size > 0 &&
      summarySuccessful &&
      summaryRunId != null &&
      (settings.unrecognizedFilesScanFinishedAt == null ||
        settings.unrecognizedFilesScanFinishedAt === summary?.finishedAt);
    let snapshotRunId: string | null = null;
    if (unrecognizedByIdentity.size > 0) {
      snapshotRunId = snapshotSharesSummaryRun
        ? summaryRunId
        : `legacy-settings-scan-snapshot:${defaultLibrary.id}`;
      if (!snapshotSharesSummaryRun) {
        insertScanRun.run(
          snapshotRunId,
          defaultLibrary.id,
          config.revision,
          "initial",
          "completed",
          snapshotFinishedAt,
          snapshotFinishedAt,
          null,
          null,
        );
      }
    }

    database
      .prepare(
        "INSERT OR IGNORE INTO media_library_scan_state (library_id) VALUES (?)",
      )
      .run(defaultLibrary.id);
    const lastStatus = summaryStatus ?? "completed";
    const lastStartedAt = summary?.startedAt ?? snapshotFinishedAt;
    const lastFinishedAt = summary?.finishedAt ?? snapshotFinishedAt;
    const lastSuccessfulAt = summarySuccessful
      ? summary?.finishedAt
      : snapshotRunId
        ? snapshotFinishedAt
        : null;
    database
      .prepare(
        `UPDATE media_library_scan_state
         SET active_run_id = NULL,
             last_status = ?,
             last_started_at = ?,
             last_finished_at = ?,
             last_successful_at = ?,
             last_summary_json = ?,
             last_error = ?
         WHERE library_id = ?`,
      )
      .run(
        lastStatus,
        lastStartedAt,
        lastFinishedAt,
        lastSuccessfulAt,
        summaryJson,
        summary?.errorSummary ?? null,
        defaultLibrary.id,
      );

    const insertUnrecognized = database.prepare(
      `INSERT OR IGNORE INTO library_unrecognized_files (
         library_id, root_id, file_path, normalized_path, reason,
         scan_run_id, last_seen_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    );
    if (snapshotRunId) {
      for (const item of unrecognizedByIdentity.values()) {
        unrecognizedFilesImported += insertUnrecognized.run(
          defaultLibrary.id,
          item.root.id,
          item.filePath,
          item.normalizedPath,
          snapshotRunId,
          snapshotFinishedAt,
        ).changes;
      }
    }
  }

  const insertCleanupJob = database.prepare(
    `INSERT OR IGNORE INTO library_root_cleanup_jobs (
       id, library_id, root_id, state, requested_at, root_path,
       normalized_root_path, normalized_real_path, device_id, inode,
       config_revision, last_error
     ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let cleanupJobsImported = 0;
  for (const identity of cleanupIdentities) {
    const root = rootByIdentity.get(identity);
    if (!root)
      throw new Error(`Legacy cleanup root was not imported: ${identity}`);
    const ready =
      root.state === "pending_removal" && hasPhysicalRootIdentity(root);
    const result = insertCleanupJob.run(
      `${LEGACY_CLEANUP_JOB_ID_PREFIX}${defaultLibrary.id}:${root.id}`,
      defaultLibrary.id,
      root.id,
      ready ? "pending" : "failed",
      root.path,
      root.normalized_path,
      root.normalized_real_path,
      root.device_id,
      root.inode,
      config.revision,
      ready ? null : LEGACY_CLEANUP_WAITING_ERROR,
    );
    cleanupJobsImported += result.changes;
  }

  return {
    libraryId: defaultLibrary.id,
    imported: true,
    rootsCreated,
    rootsUpdated,
    resourcesLinked,
    cleanupJobsImported,
    scanSummaryImported,
    unrecognizedFilesImported,
  };
}

/**
 * Move the last single-library settings snapshot into the V16 default library.
 * The database commit is the idempotency boundary; JSON cleanup is best effort.
 */
export function bootstrapLegacyMediaLibrary(
  dependencies: LegacyMediaLibraryBootstrapDependencies,
): LegacyMediaLibraryBootstrapResult {
  const settings = dependencies.readSettings();
  const importTransaction = dependencies.database.transaction(() =>
    importLegacySettings(dependencies.database, settings),
  );
  const imported = importTransaction.immediate();
  return {
    ...imported,
    settingsCleanup: cleanupLegacySettings(dependencies.updateSettings),
  };
}
