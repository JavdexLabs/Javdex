import type { ActressAvatarAutoCropTarget, ActressAvatarCropTargetPage } from '@shared/actressAvatarCropTypes'
import type { ActressAvatarCropSnapshot } from '@library/db/actressAvatarCropSnapshot'
import type { CatalogBackend } from '../application/catalogBackend'

const CROP_PAGE_LIMIT = 100
const CROP_PAGE_HARD_CAP = 100_000

interface CatalogActressCropRow {
  id: number
  main_name: string
  avatar_path?: string | null
  avatar_source_path?: string | null
}

function hasCroppableAvatar(row: CatalogActressCropRow): boolean {
  return Buffer.byteLength(row.avatar_path ?? '') > 0 || Buffer.byteLength(row.avatar_source_path ?? '') > 0
}

function displayName(mainName: string): string {
  const points = Array.from(mainName)
  return points.slice(0, 128).join('') + (points.length > 128 ? '…' : '')
}

function toTarget(row: CatalogActressCropRow): ActressAvatarAutoCropTarget {
  return { actressId: row.id, mainName: displayName(row.main_name) }
}

export async function collectCatalogActressAvatarCropTargets(
  catalog: CatalogBackend
): Promise<ActressAvatarAutoCropTarget[]> {
  const items: ActressAvatarAutoCropTarget[] = []
  let offset = 0
  for (;;) {
    const page = (await catalog.actresses.listPage({
      gender: 'all',
      status: 'all',
      avatar: 'all',
      limit: CROP_PAGE_LIMIT,
      offset
    })) as { items?: CatalogActressCropRow[]; total?: number }
    const rows = Array.isArray(page.items) ? page.items : []
    for (const row of rows) {
      if (hasCroppableAvatar(row)) items.push(toTarget(row))
    }
    offset += rows.length
    if (
      rows.length === 0 ||
      rows.length < CROP_PAGE_LIMIT ||
      (typeof page.total === 'number' && offset >= page.total) ||
      offset >= CROP_PAGE_HARD_CAP
    ) {
      break
    }
  }
  return items
}

export async function loadCatalogActressAvatarCropSnapshot(
  catalog: CatalogBackend
): Promise<ActressAvatarCropSnapshot> {
  const frozen = await collectCatalogActressAvatarCropTargets(catalog)
  let disposed = false
  return {
    page(afterId: number): ActressAvatarCropTargetPage {
      if (disposed) throw new Error('头像任务快照已失效')
      if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('无效的头像任务游标')
      const remaining = frozen.filter((item) => item.actressId > afterId)
      const items = remaining.slice(0, 100)
      return {
        items,
        total: frozen.length,
        nextAfterId: remaining.length > 100 ? items[items.length - 1]?.actressId ?? null : null
      }
    },
    dispose() {
      disposed = true
    }
  }
}
