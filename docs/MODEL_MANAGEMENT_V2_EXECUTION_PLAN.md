# Model Management v2 Execution Plan

Status: completed and consolidated against the v0.5.0 release
Started: 2026-08-22
Consolidated: 2026-08-24

This file records the public model-management configuration evolving from the v0.5.0 AppSettings
contract (baseline v1) to the schema v2 document. The file is new, but the configuration domain replaces
the released provider/model settings rather than introducing an unrelated format. Development-only
intermediate schemas are intentionally not part of the persisted contract.

## Invariants

- `ai-configuration.json` schema v2 is the only runtime source for providers, models and workload assignments.
- User-facing concepts are provider, model and workload. Route, Preset, Profile, ToolPack, grants and verifier are not editable model settings.
- `app-default` is explicit. `plugin-developer` and `library-curator` may inherit it or select a model explicitly.
- Agent definitions, ToolPacks, grants and approvals remain code-owned.
- Running Agent configurations stay frozen; edits affect only new runs.
- Released AppSettings LLM fields are migration-only and never receive new writes after model management exists.
- API keys remain in the credential vault and never enter snapshots, logs or renderer state.

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

- A valid schema v2 document is read directly; malformed or unknown persisted documents fail closed.
- When the document does not exist, migrate the released `settings.json` LLM fields directly to schema v2.
- Before first migration, create the non-overwriting `settings.llm-v1.backup.json` from a strict non-secret whitelist.
- No development-only AI configuration schema is accepted as a migration source.

## UI and IPC

- IPC: modelManagementGet, modelManagementApply, modelManagementDiscoverModels and modelManagementTestModel.
- Renderer code cannot access raw AI configuration or legacy provider/model mutations.
- Model settings tabs: `用途与运行`, `提供商与模型`, `高级`.
- Assignment and connection edits require explicit Save. Discovery does not persist until Add.
- Configured providers appear first; unconfigured built-ins are collapsed.
- PluginDeveloper preflight uses the workload snapshot; active sessions show their frozen model.

## Verification Gates

Completion requires Node/Web typecheck, ESLint, Stylelint, Electron/Renderer tests, production build,
CSS architecture, encoding and `git diff --check`.

## Consolidation Record

- 2026-08-24: compared with published v0.5.0, removed the unshipped model-management migration ladder,
  advanced the released model-settings contract once from v1 to the schema v2 document, and retained
  direct migration from released settings only.
- The deep Module, command IPC boundary, workload-oriented UI, frozen-run behavior, credential isolation,
  nested validation, compensated writes and renderer URL sanitization remain unchanged.
