import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { updateSettings } from '../settings/settingsStore'
import { ScraperDelayController } from './scraperDelayController'

let tempRoot: string | null = null
let oldUserData: string | null = null

beforeEach(() => {
  oldUserData = process.env.JAVDEX_TEST_USER_DATA ?? null
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-delay-controller-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  updateSettings({
    batchDelayMinMs: 1000,
    batchDelayMaxMs: 1000,
    scraperPluginDelays: {
      video: {},
      actress: {}
    }
  })
})

afterEach(() => {
  if (oldUserData) {
    process.env.JAVDEX_TEST_USER_DATA = oldUserData
    oldUserData = null
  } else {
    delete process.env.JAVDEX_TEST_USER_DATA
  }
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('ScraperDelayController', () => {
  it('starts the next same-site interval after the previous access finishes', async () => {
    let now = 0
    const sleeps: number[] = []
    const waits: number[] = []
    const controller = new ScraperDelayController({
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
      onWait: ({ waitMs }) => waits.push(waitMs)
    })

    await controller.run('video', 'JavDB', async () => {
      now += 2000
      return null
    })
    await controller.run('video', 'MissAV', async () => null)
    await controller.run('video', 'JavDB', async () => null)

    assert.deepEqual(sleeps, [1000])
    assert.deepEqual(waits, [1000])
  })
})
