import type { CatalogBackend } from './catalogBackend'
import type { CatalogOperationInput, CatalogWireInput } from './catalogOperationInputs'
import type { CatalogOperationResults } from './catalogOperationResults'
import type { CatalogMethodSlice } from './catalogMethods'

type IsAny<T> = 0 extends (1 & T) ? true : false
type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false

type UntypedOperations = {
  [K in keyof CatalogOperationResults]: IsAny<CatalogOperationInput<K>> extends true ? K
    : IsAny<CatalogOperationResults[K]> extends true ? K
    : unknown extends CatalogOperationResults[K] ? K : never
}[keyof CatalogOperationResults]

type PortOperations = {
  [S in CatalogMethodSlice]: {
    [M in keyof CatalogBackend[S]]: CatalogBackend[S][M] extends
      (input: infer I, ...args: never[]) => Promise<infer R>
      ? IsAny<I> extends true ? M : IsAny<R> extends true ? M : never
      : M
  }[keyof CatalogBackend[S]]
}[CatalogMethodSlice]

export type ContractChecks = [
  Assert<Equal<UntypedOperations, never>>,
  Assert<Equal<PortOperations, never>>,
  Assert<Equal<Awaited<ReturnType<CatalogBackend['videos']['setRating']>>, boolean>>,
  Assert<Equal<Awaited<ReturnType<CatalogBackend['playlists']['create']>>, number>>,
  Assert<Equal<Parameters<CatalogBackend['queries']['getVideo']>[0], CatalogOperationInput<'videos.get'>>>
]

// Compile-only negative tests: no backend is created and no mutation is executed.
export function checkCatalogCalls(backend: CatalogBackend): void {
  const context = { operationId: 'operation', expectedVersions: {} }
  void backend.videos.setRating({ videoId: 1, rating: 4 }, context)
  void backend.libraries.addRoot({ libraryId: 1, expectedRevision: 2, root: { path: '/media' } }, context)
  void backend.libraries.addRoot({ libraryId: 1, root: { mountSelectionId: 'mount' } }, context)
  void backend.videos.importSamples({ videoId: 1, source: 'file', sourcePath: '/image.jpg' }, context)
  // @ts-expect-error operation-specific required input
  void backend.videos.setRating({ videoId: 1 }, context)
  // @ts-expect-error an actress identifier is not a video identifier field
  void backend.queries.getVideo({ actressId: 1 })
  // @ts-expect-error empty operation inputs must not accept arbitrary properties
  void backend.queries.listTags({ accidental: true })
  // @ts-expect-error wrong result cannot be assigned through the backend
  const count: Promise<number> = backend.queries.getVideo({ scope: { kind: 'all' }, videoId: 1 })
  void count
  // @ts-expect-error desktop paths are deliberately absent from HTTP roots
  const wireRoot: CatalogWireInput<'libraries.addRoot'> = { libraryId: 1, root: { path: '/media' } }
  void wireRoot
  // @ts-expect-error desktop cover paths are absent from HTTP edit fields
  const wireEdit: CatalogWireInput<'videos.edit'> = { videoId: 1, fields: { coverSourcePath: '/image.jpg' } }
  void wireEdit
  // @ts-expect-error results are truly keyed, not a union of all operation results
  const wrongResult: CatalogOperationResults['playlists.create'] = { playlistId: 1 }
  void wrongResult
}
