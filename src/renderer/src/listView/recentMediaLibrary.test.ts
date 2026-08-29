import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  RECENT_MEDIA_LIBRARY_STORAGE_KEY,
  readRecentMediaLibraryId,
  rememberRecentMediaLibraryId
} from './recentMediaLibrary'

function memoryStorage(initial?: string): {
  values: Map<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
} {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(RECENT_MEDIA_LIBRARY_STORAGE_KEY, initial)
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
}

describe('recent media-library memory', () => {
  it('stores only positive safe library ids and ignores malformed persisted state', () => {
    const storage = memoryStorage()
    rememberRecentMediaLibraryId(7, storage)
    assert.equal(readRecentMediaLibraryId(storage), 7)

    rememberRecentMediaLibraryId(0, storage)
    assert.equal(readRecentMediaLibraryId(storage), 7)
    assert.equal(readRecentMediaLibraryId(memoryStorage('1.5')), null)
    assert.equal(readRecentMediaLibraryId(memoryStorage('9007199254740992')), null)
  })
})
