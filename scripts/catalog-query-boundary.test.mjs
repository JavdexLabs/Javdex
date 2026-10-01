import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bypassesCatalogQuery } from './lib/catalog-query-boundary.mjs'

test('migrated hosts cannot reach video repositories through aliases or relative imports', () => {
  for (const specifier of ['@library/db/videoRepo', '@javdex/library/db/scopedVideoCatalogRepo', '../../../packages/library/src/db/videoRepo.ts']) {
    assert.equal(bypassesCatalogQuery(specifier, 'apps/server/src/manageDispatch.ts'), true)
  }
  assert.equal(bypassesCatalogQuery('@library/catalog/videoQueryService', 'apps/server/src/manageDispatch.ts'), false)
  assert.equal(bypassesCatalogQuery('@library/db/database', 'apps/server/src/manageDispatch.ts'), false)
  assert.equal(bypassesCatalogQuery('@library/db/videoRepo', 'packages/library/src/catalog/videoQueryService.ts'), false)
  const desktop = 'apps/desktop/src/main/services/videoQueryService.ts'
  for (const specifier of ['@library/db/videoRepo', '@javdex/library/db/scopedVideoCatalogRepo', '../../../../../packages/library/src/db/videoRepo']) {
    assert.equal(bypassesCatalogQuery(specifier, desktop), true)
  }
  assert.equal(bypassesCatalogQuery('@library/catalog/videoQueryService', desktop), false)
})
