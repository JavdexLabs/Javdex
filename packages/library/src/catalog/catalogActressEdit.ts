import type { ActressEditResult } from '@shared/actressEditContract'
import type { ActressEditInput } from '@shared/actressTypes'
import type { CatalogImageRef } from '@shared/protocol/uploads'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { editActressWithAssets } from './actressAssetService'
import { assertExpectedActressVersion, readActressAggregateVersion } from './catalogAggregateVersion'
import { commitManageImageMutation, prepareActressAvatarRef } from './catalogImageApply'
import type { CatalogWriteContext } from './catalogOperations'

export interface CatalogActressEditInput {
  actressId: number
  fields: ActressEditInput
  /** Host-normalized managed upload or clear reference, separate from local image inputs. */
  avatarRef?: CatalogImageRef
}

/** One receipt, version check and aggregate UPDATE for a profile/avatar edit. */
export function editCatalogActress(
  input: CatalogActressEditInput,
  context: CatalogWriteContext,
  legacyLocal = false
) {
  return mediaAssetStore.coordinateDatabaseChange(() => commitManageImageMutation(
    {
      ...context,
      operation: 'actresses.edit',
      // Keep the existing wire digest so persisted operations remain replayable.
      input: {
        actressId: input.actressId,
        fields: { ...input.fields, ...(input.avatarRef ? { avatar: input.avatarRef } : {}) }
      }
    },
    (): ActressEditResult => {
      // Existing desktop IPC omits A. Supplied versions are always checked;
      // HTTP never opts into the legacy path.
      if (!legacyLocal || context.expectedVersions.A) {
        assertExpectedActressVersion(input.actressId, context.expectedVersions, context.operationId, context.database)
      }
      const avatar = input.avatarRef
        ? prepareActressAvatarRef(input.actressId, input.avatarRef, context.operationId, context.database)
        : undefined
      editActressWithAssets(input.actressId, input.fields, avatar)
      return { ok: true, versions: { A: readActressAggregateVersion(input.actressId, context.database)! } }
    },
    context.database
  ))
}
