import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { closeDatabase } from '@library/db/database'
import { resetLibraryHostForTests } from '@library/runtime/host'
import { hashPassword } from '@http/auth'
import { issueDeployToken, issueMigrationToken } from './identity'
import type { ServerConfig } from './config'

describe('deploy one-time tokens', () => {
  it('issues bind tokens without occupancy files and can replace an unused bootstrap token', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-deploy-token-'))
    const dataDir = path.join(root, 'data')
    const imagesDir = path.join(root, 'images')
    const staticRoot = path.join(root, 'web')
    fs.mkdirSync(staticRoot)
    fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html>')
    const passwordHash = await hashPassword('correct horse battery')
    const config: ServerConfig = {
      listenHost: '127.0.0.1',
      port: 0,
      accessHosts: ['127.0.0.1'],
      dataDir,
      imagesDir,
      staticRoot,
      mediaMounts: {},
      web: { username: 'viewer', passwordHash }
    }
    try {
      const first = issueDeployToken(config, 'initialBind')
      assert.equal(first.kind, 'initialBind')
      assert.ok(first.oneTimeToken.length >= 32)
      const bootstrap = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`
      const sameUnbound = issueDeployToken(config, 'initialBind', { bootstrapToken: bootstrap })
      assert.equal(sameUnbound.oneTimeToken, bootstrap)
      assert.equal(sameUnbound.catalogId, first.catalogId)
      assert.equal(fs.existsSync(path.join(dataDir, 'instance-bind.json')), false)
    } finally {
      closeDatabase()
      resetLibraryHostForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('issues a CLI migration token without an HTTP issue-token op', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-token-'))
    const dataDir = path.join(root, 'data')
    const imagesDir = path.join(root, 'images')
    const staticRoot = path.join(root, 'web')
    fs.mkdirSync(staticRoot)
    fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html>')
    const passwordHash = await hashPassword('correct horse battery')
    const config: ServerConfig = {
      listenHost: '127.0.0.1',
      port: 0,
      accessHosts: ['127.0.0.1'],
      dataDir,
      imagesDir,
      staticRoot,
      mediaMounts: {},
      web: { username: 'viewer', passwordHash }
    }
    try {
      const issued = issueMigrationToken(config)
      assert.ok(issued.oneTimeToken.length >= 32)
      assert.equal(issued.serverId.length, 36)
      assert.equal(issued.catalogId.length, 36)
    } finally {
      closeDatabase()
      resetLibraryHostForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
