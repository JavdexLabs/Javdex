# Model Management v3 Execution Plan

Status: completed and post-implementation audit verified
Started: 2026-08-22
Owner: current Codex thread

This file is the execution anchor for the model-management refactor. After context compaction,
read this file before changing code. Do not change the architecture decisions below without first
recording the reason here.

## Invariants

- `ai-configuration.json` schema v3 is the only runtime source for providers, models and workload assignments.
- User-facing concepts are provider, model and workload. Route, Preset, Profile, ToolPack, grants and verifier are not editable model settings.
- `app-default` is explicit. `plugin-developer` and `library-curator` may inherit it or select a model explicitly.
- Agent definitions, ToolPacks, grants and approvals remain code-owned.
- Running Agent configurations stay frozen; edits affect only new runs.
- Legacy AppSettings LLM fields are migration-only and never receive new writes.
- API keys remain in the credential vault and never enter snapshots, logs or renderer state.
- Existing dirty-worktree changes are user work. Inspect overlapping diffs before every patch; never reset or overwrite unrelated edits.

## Public Interface

`ModelManagementModule` exposes only `read`, `apply`, `discoverModels`, `testModel` and `resolve`.
Its file store, credential vault and provider transport are internal seams with production and test Adapters.

Workloads are `app-default`, `plugin-developer` and `library-curator`. Runtime policy includes thinking,
max output (`0` = model maximum), timeout, cache retention, compaction, max turns (`0` = unlimited) and
max context tokens.

Mutation commands are: set default model, set workload assignment, save/remove connection, add/remove
model, set/reset model override. Expected domain errors are revision conflict, model/connection in use,
connection not ready, model lacks tools, unsupported long cache and validation failure.

## Migration

- Read valid v3 directly; invalid v3 fails closed.
- Migrate v2 plus legacy settings in one step; create v3 from settings if no AI document exists.
- Preserve model capability/cache evidence and workload runtime/compaction/limits.
- Primary and summarizer resolve to one workload model. Verifier is not migrated as a workload.
- Before first migration, create non-overwriting `ai-configuration.v2.backup.json` and
  `settings.llm-v2.backup.json` (non-secret LLM fields only).
- Existing frozen run snapshots remain readable and are not migrated or closed.

## UI and IPC

- IPC: modelManagementGet, modelManagementApply, modelManagementDiscoverModels and modelManagementTestModel.
- Remove renderer access to raw AI configuration and legacy provider/model mutations.
- Model settings tabs: `用途与运行`, `提供商与模型`, `高级`.
- Assignment and connection edits require explicit Save. Discovery does not persist until Add.
- Configured providers appear first; unconfigured built-ins are collapsed.
- PluginDeveloper preflight uses the workload snapshot; active sessions show their frozen model.

## Phase Checklist

- [x] Phase 0: record invariants and dirty-worktree baseline.
- [x] Phase 1: shared types, deep Module, internal Adapters, migration and Interface tests.
- [x] Phase 2: runtime cutover for ModelControlPlane, AgentConfiguration, both Agents, translation and limits.
- [x] Phase 3: command IPC/preload cutover; remove legacy sync writes.
- [x] Phase 4: replace model UI and update Overview/PluginDeveloper projections.
- [x] Phase 5: delete obsolete paths/tests, add ADR/docs, run full verification.

## Phase Gates

1. Module tests and Node typecheck must pass before runtime cutover.
2. Agent/runtime tests must pass before deleting legacy IPC.
3. IPC schemas and preload types must pass before renderer cutover.
4. Web typecheck and renderer tests must pass before legacy UI deletion.
5. Completion requires Node/Web typecheck, relevant ESLint, Electron/renderer tests, `npm test`, build,
   CSS architecture, encoding and `git diff --check`.

## Execution Log

- 2026-08-22: Phase 0 recorded. Repository already contains extensive PluginDeveloper, browser-helper,
  packaging and model-control changes. Model-management v3 files did not yet exist at the baseline.
- 2026-08-22: Phase 1 completed. Added `src/shared/modelManagementTypes.ts` and the deep
  `ModelManagementModule` with file-store, credential-vault and provider-transport Adapters. Added strict
  v3 reads, v2/settings migration with non-secret backups, optimistic revisions, compensated credential
  writes, discovery/test operations and workload resolution. Updated the connection-test transport to
  accept already-resolved request configurations. Gate results: Node typecheck passed; Module Interface
  tests 9/9 passed; related ESLint passed.
- 2026-08-22: Phase 2 completed. ModelControlPlane now resolves workload IDs through v3 while retaining
  frozen-snapshot restoration and one temporary legacy profile adapter. AgentConfiguration projects
  code-owned ToolPacks, grants and approvals and injects only workload compaction. PluginDeveloper,
  LibraryCurator and translation now resolve their designated workloads; primary and summarizer share one
  access, verifier cache/model resolution is disabled, limits come from the PluginDeveloper assignment,
  and generic JSON invocation requires an explicitly supplied frozen access. Gate results: Node typecheck
  passed; runtime/Agent/PluginDeveloper/translation tests 48/48 passed; related ESLint passed.
- 2026-08-22: Phase 3 completed. Replaced raw v2 and legacy provider Renderer channels with four
  command-oriented model-management channels, strict discriminated-union IPC schemas and typed preload
  methods. Domain errors return structured mutation failures while unknown faults remain ordinary IPC
  errors; discovery and model tests use 30-second cancellation. Settings snapshots and generic settings
  patches no longer expose or accept legacy model/provider/Agent limit fields. Removed legacy settings-to-v2
  synchronization and v2 raw save/snapshot APIs. Renderer snapshots omit credential references and sanitize
  Base URL credentials/query fragments. Gate results: Node typecheck passed; IPC/schema, Module, v2 migration
  and settings tests 53/53 passed; related ESLint passed.
- 2026-08-22: Phase 4 completed. Replaced the monolithic model settings screen with compact workload,
  provider/model and advanced panels backed only by `ModelManagementSnapshot`; edits remain local until an
  explicit save command. Added one provider detail modal for connection credentials, discovery, testing and
  confirmed deletion. Settings Overview now reads the v3 default assignment. PluginDeveloper preflight reads
  its workload assignment, while active and restored runs expose the model frozen in their persisted run
  configuration. Removed the unused Renderer Route/Preset/Profile-era model components. Gate results: Node
  and Web typechecks passed; focused settings/PluginDeveloper Renderer and lifecycle tests 36/36 passed;
  related ESLint and Stylelint passed; CSS architecture debt decreased from the baseline 804 descendant
  selectors to 799.
- 2026-08-22: Phase 5 completed. Removed the obsolete v2 repository/raw-save path, legacy provider/model
  Renderer components, settings synchronization writes, unused verifier/model-role configuration entrypoints
  and the retired global model-settings stylesheet. Added ADR 0022 and updated Agent platform and
  PluginDeveloper documentation to make schema v3 the sole runtime configuration source. The final CSS
  architecture count is 784 descendant selectors, down from the 804 baseline. Full verification passed:
  Node/Web typecheck, ESLint, Stylelint, packaging checks and 1305/1305 Electron/Renderer tests; production
  build, encoding check and `git diff --check` also passed. An isolated production-build smoke at exactly
  1280×720 confirmed all three model tabs, the independently bounded provider modal, keyboard focus restore
  and the absence of Route/Preset/Profile/ToolPack/grants/verifier terminology. No architecture deviations
  were introduced; the temporary smoke profile was isolated from the user's installed application.
- 2026-08-23: A completion audit found and fixed several fail-open or compatibility gaps that the phase
  gates did not originally cover. Schema v3 now validates every nested persisted value, rejects embedding
  catalog entries and invalid connection identities, and normalizes migrated credential references so new
  frozen runs remain restorable. The v2 migration now retains v2-only connections, models, capability/cache
  evidence and primary workload choices. Once v3 exists, ordinary settings writes remove all retired LLM
  fields instead of silently recreating a second configuration source. Workload context limits are frozen
  into resolved model access, connection contract changes refresh derived model metadata, and empty execution
  artifacts can no longer pass plugin installation acceptance.
- 2026-08-23: The same audit separated browser action success from observation lifetime: evaluate timeout now
  destroys the active helper/page context before the lease can be reused, sensitive credential/storage/form
  APIs are denied by one shared evaluator policy, and complete oversized ARIA remains in the artifact rather
  than being truncated before persistence. PluginDeveloper-specific conversation, connection and result
  styles were moved into CSS Modules; destructive provider/model actions become visually destructive only
  after confirmation.
- 2026-08-23: The migration backup now uses a strict non-secret whitelist and sanitizes Base URLs before
  writing, while an unreadable or invalid v3 document prevents later settings writes from resurrecting
  retired LLM fields. The model settings tabs now use roving keyboard focus with complete tab/tabpanel ARIA
  relationships.
- 2026-08-23: Final post-audit gates passed: Node/Web typecheck, ESLint, Stylelint, CSS architecture, encoding,
  production build, helper smoke, packaged Agent runtime verification, and 1317/1317 Electron/Renderer tests.
  Fresh x64 and arm64 DMGs were built and verified. The packaging launcher now selects a compatible macOS
  Python for Electron's node-gyp when a newer Homebrew Python omits `distutils`; its packaging suite passes
  5/5. Current artifacts are 137 MiB (x64) and 132 MiB (arm64), each with a verified 79.2 MiB app.asar.
