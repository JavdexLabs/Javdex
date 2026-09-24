import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectCatalogActressAvatarCropTargets,
  loadCatalogActressAvatarCropSnapshot
} from './catalogActressAvatarCropSnapshot'
import type { CatalogBackend } from './catalogBackend'

function catalogWithPages(
  pages: Array<{ items: Array<{
    id: number
    main_name: string
    avatar_path?: string | null
    avatar_source_path?: string | null
  }>; total: number }>
): CatalogBackend {
  return {
    actresses: {
      listPage: async (input: { offset?: number; gender?: string }) => {
        assert.equal(input.gender, 'all')
        const offset = input.offset ?? 0
        if (offset === 0) return pages[0]
        return { items: [], total: pages[0]?.total ?? 0 }
      }
    }
  } as unknown as CatalogBackend
}

describe('catalog actress avatar crop snapshot', () => {
  it('freezes croppable actresses from catalog pages and ignores empty avatar paths', async () => {
    const catalog = catalogWithPages([
      {
        items: [
          { id: 1, main_name: 'Keep', avatar_path: 'a.jpg' },
          { id: 2, main_name: 'Skip', avatar_path: '', avatar_source_path: null },
          { id: 3, main_name: 'Source', avatar_source_path: 'src.png' }
        ],
        total: 3
      }
    ])
    const targets = await collectCatalogActressAvatarCropTargets(catalog)
    assert.deepEqual(targets, [
      { actressId: 1, mainName: 'Keep' },
      { actressId: 3, mainName: 'Source' }
    ])
    const snapshot = await loadCatalogActressAvatarCropSnapshot(catalog)
    assert.deepEqual(snapshot.page(0), {
      items: [
        { actressId: 1, mainName: 'Keep' },
        { actressId: 3, mainName: 'Source' }
      ],
      total: 2,
      nextAfterId: null
    })
    snapshot.dispose()
    assert.throws(() => snapshot.page(0), /已失效/)
  })
})
