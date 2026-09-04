import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mediaAssetStore } from '../services/mediaAssetStore'
import type { ManagedRootFileCapability, VideoMetadataCandidate } from './types'
import { createVideoMetadataCandidateStager } from './videoMetadataCandidateStager'

const MINIMAL_JPEG = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

let tempRoot: string | null = null
let previousUserData: string | undefined

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-metadata-stager-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
})

afterEach(() => {
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  previousUserData = undefined
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('videoMetadataCandidateStager', () => {
  it('stages remote and managed-root assets without persisting host paths', async () => {
    const candidate: VideoMetadataCandidate = {
      result: {
        code: 'TEST-001',
        coverUrl: 'https://image.example/cover.jpg',
        sampleImageUrls: ['managed sample'],
        actresses: [{ name: 'Example Actress', gender: 'female', avatarUrl: 'managed avatar' }]
      },
      evidence: {
        kind: 'web-scraper',
        sourceId: 'web-scraper:Contract',
        sourceName: 'Contract',
        sourceUrl: 'https://example.test/item'
      },
      assets: [
        {
          kind: 'remote-url',
          field: 'cover',
          position: 0,
          url: 'https://image.example/cover.jpg'
        },
        {
          kind: 'managed-root-file',
          field: 'samples',
          position: 0,
          capability: {} as ManagedRootFileCapability,
          filename: 'TEST-001-fanart.jpg'
        },
        {
          kind: 'managed-root-file',
          field: 'actressAvatar',
          position: 0,
          capability: {} as ManagedRootFileCapability,
          filename: 'Example_Actress.jpg'
        }
      ]
    }
    const stager = createVideoMetadataCandidateStager({
      fetchRemote: async () => MINIMAL_JPEG,
      readManagedRootFile: async () => MINIMAL_JPEG
    })

    const staged = await mediaAssetStore.coordinateDatabaseChange(() =>
      stager.stageForPending([candidate])
    )

    assert.equal(staged.warnings.length, 0)
    assert.equal(staged.candidates.length, 1)
    assert.deepEqual(
      staged.candidates[0].resources.map((resource) => [resource.field, resource.position]),
      [
        ['cover', 0],
        ['samples', 0],
        ['actressAvatar', 0]
      ]
    )
    const serialized = JSON.stringify(staged)
    assert.doesNotMatch(serialized, /\/private\/library/)
    for (const resource of staged.candidates[0].resources) {
      assert.equal(
        fs.existsSync(path.join(tempRoot!, 'media_assets', resource.stagedPath)),
        true
      )
    }
  })
})
