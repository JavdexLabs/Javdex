import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { handleManageHttpRequest, type ManageHttpSurface } from './manage'

test('backup download releases its deletion guard after streaming and on invalid offsets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-backup-http-'))
  const file = path.join(directory, 'backup.bin')
  fs.writeFileSync(file, 'backup payload')
  let releases = 0
  let active = 0
  const manage: ManageHttpSurface = {
    appVersion: '0.8.0-beta.1', dispatch: () => ({}),
    transferBackup: async () => {
      active++
      return { file, release: () => { active--; releases++ } }
    }
  }
  const server = createServer((request, response) => {
    void handleManageHttpRequest(request, response, new URL(request.url!, 'http://localhost'), manage, true)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/manage/v1/backups/aa31510e-6389-48d9-ad58-225635954dbc`
  const headers = { 'x-javdex-app-version': manage.appVersion }
  try {
    const response = await fetch(url, { headers })
    assert.equal(response.status, 206)
    assert.equal(await response.text(), 'backup payload')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(active, 0)
    assert.equal(releases, 1)
    const invalid = await fetch(`${url}?offset=100`, { headers })
    assert.equal(invalid.status, 400)
    await invalid.text()
    assert.equal(active, 0)
    assert.equal(releases, 2)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
