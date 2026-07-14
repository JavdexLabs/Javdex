import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  readAvatarCompositionPreviewCache,
  writeAvatarCompositionPreviewCache,
  type CachedAvatarCompositionAnalysis
} from './previewCache'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('avatar composition preview cache', () => {
  it('persists and restores the complete normalized face analysis', () => {
    const storage = new MemoryStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: storage }
    })

    const analysis: CachedAvatarCompositionAnalysis = {
      imageWidth: 1254,
      imageHeight: 1254,
      candidate: {
        id: 'preview-face',
        confidence: 0.99,
        prominence: 1,
        box: { x: 0.4, y: 0.28, width: 0.2, height: 0.25 },
        leftEye: { x: 0.46, y: 0.37 },
        rightEye: { x: 0.54, y: 0.37 },
        ovalTop: { x: 0.5, y: 0.29 },
        chin: { x: 0.5, y: 0.52 },
        leftCheek: { x: 0.43, y: 0.43 },
        rightCheek: { x: 0.57, y: 0.43 },
        headBounds: { x: 0.31, y: 0.18, width: 0.38, height: 0.46 },
        geometrySource: 'mesh'
      }
    }

    writeAvatarCompositionPreviewCache(analysis)
    assert.deepEqual(readAvatarCompositionPreviewCache(), analysis)

    delete (globalThis as { window?: unknown }).window
  })
})
