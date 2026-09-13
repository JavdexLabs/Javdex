import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isStructuredError } from '@shared/protocol/errors'
import { createRemoteCatalogBackend } from './remoteCatalogBackend'
import { remoteImageCacheCatalogDir } from '../../services/remoteImageDiskCache'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function handshakeBody(catalogId: string) {
  return {
    protocolVersion: 1,
    appVersion: '0.7.0',
    schemaVersion: 19,
    identity: { serverId: 'server-1', catalogId },
    writerEpoch: 1,
    ready: 'ready',
    capabilities: {
      encryptedAssets: false,
      transcoding: false,
      arbitraryUrlProxy: false,
      pluginExecution: false,
      publicInternetDefault: false,
      writerBound: true,
      browserEnabled: true,
      managementEnabled: true
    }
  }
}

function memoryCredentials() {
  return {
    async isAvailable() {
      return true
    },
    async readWriterSecret() {
      return 'writer-secret'
    },
    async writeWriterSecret() {
      return
    },
    async deleteWriterSecret() {
      return
    }
  }
}

describe('RemoteCatalogBackend image disk cache', () => {
  const roots: string[] = []
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
    )
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('reuses a catalog-scoped disk entry and ignores aborted fetches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s11-remote-img-'))
    roots.push(root)
    let assetGets = 0
    let hold = Promise.resolve()
    let releaseLate: () => void = () => undefined
    const http = createHttpServer((request, response) => {
      const url = request.url ?? ''
      if (url.endsWith('/handshake.get')) {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(handshakeBody('catalog-cache')))
        return
      }
      if (url.includes('/manage/v1/assets/')) {
        assetGets += 1
        const count = assetGets
        void hold.then(() => {
          if (response.writableEnded || response.destroyed) return
          response.setHeader('Content-Type', 'image/png')
          response.end(count === 1 ? PNG : Buffer.concat([PNG, Buffer.from('2')]))
        })
        return
      }
      response.statusCode = 404
      response.end()
    })
    servers.push(http)
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('port')
    const backend = createRemoteCatalogBackend({
      baseUrl: `http://127.0.0.1:${address.port}`,
      appVersion: '0.7.0',
      credentials: memoryCredentials(),
      userDataPath: root
    })
    try {
      const first = await backend.assets.readImage({ relPath: 'covers/a.png' })
      assert.equal(assetGets, 1)
      assert.deepEqual(first.body, PNG)
      const second = await backend.assets.readImage({ relPath: 'covers/a.png' })
      assert.equal(assetGets, 1)
      assert.deepEqual(second.body, PNG)
      assert.equal(fs.existsSync(remoteImageCacheCatalogDir(root, 'catalog-cache')), true)

      hold = new Promise<void>((resolve) => {
        releaseLate = resolve
      })
      const abort = new AbortController()
      const pending = backend.assets.readImage({ relPath: 'covers/late.png' }, { signal: abort.signal })
      const started = Date.now()
      while (assetGets < 2 && Date.now() - started < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      abort.abort()
      releaseLate()
      await assert.rejects(
        pending,
        (error: unknown) => isStructuredError(error) && error.code === 'CONNECTION_UNAVAILABLE'
      )
      hold = Promise.resolve()
      await backend.assets.readImage({ relPath: 'covers/late.png' })
      assert.equal(assetGets, 3)
    } finally {
      await backend.dispose()
    }
  })
})
