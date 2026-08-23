import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginExecutionArtifact } from '@shared/pluginDevTypes'
import { executeTool, releasePluginDeveloperBrowser } from './toolExecutor'
import { createSession, deleteSession } from './sessionStore'
import { pluginWorkspace } from './pluginWorkspace'
import { pluginExecution, pluginRunTargetFingerprint, PLUGIN_RUNTIME_VERSION } from './pluginExecution'
import { PLUGIN_UNMATCHED_TARGET_ERROR } from '../pluginDevService'
import { pluginArtifactHash } from './pluginArtifact'
import {
  ScrapeBrowserBusyError,
  scrapeBrowser,
  type ScrapeBrowserLease
} from '../../scrapers/scrapeBrowser'
import { resetSettingsCacheForTests } from '../../settings/settingsStore'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function createWorkspaceSession(
  id: string,
  kind: 'video' | 'actress' = 'video',
  testTargets: string[] = kind === 'video' ? ['ABC-1', 'ABC-2'] : ['Alice']
) {
  const input = {
    mode: 'create' as const,
    kind,
    siteName: 'Executor Test',
    siteUrl: 'https://example.test',
    supportedFields: ['title' as const],
    testTargets
  }
  const session = createSession(input, id)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-tool-executor-'))
  directories.push(directory)
  session.workspaceDirectory = directory
  pluginWorkspace.open({ directory, task: input, package: session.package })
  return session
}

function installFakeBrowserLease(): () => void {
  const original = scrapeBrowser.acquire
  const previousUserData = process.env.JAVDEX_TEST_USER_DATA
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-tool-settings-'))
  directories.push(userData)
  process.env.JAVDEX_TEST_USER_DATA = userData
  resetSettingsCacheForTests()
  const lease: ScrapeBrowserLease = {
    ownerId: 'test',
    purpose: 'agent-browser',
    fetchPage: async () => '',
    fetchBuffer: async () => Buffer.alloc(0),
    fetchBufferResponse: async () => ({ statusCode: 200, body: Buffer.alloc(0) }),
    pluginAction: async () => ({}),
    agentAction: async (command) => ({ action: command.action }),
    presentToUser: async () => ({ url: 'https://example.test', title: 'Example' }),
    recycle: async () => undefined,
    release: async () => undefined
  }
  scrapeBrowser.acquire = async () => lease
  return () => {
    scrapeBrowser.acquire = original
    if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previousUserData
    resetSettingsCacheForTests()
  }
}

function fakeArtifact(input: Parameters<typeof pluginExecution.run>[0]): PluginExecutionArtifact {
  return {
    runtimeVersion: PLUGIN_RUNTIME_VERSION,
    artifactHash: pluginArtifactHash(input.package),
    targetFingerprint: pluginRunTargetFingerprint(input.targets),
    scope: input.scope,
    targets: structuredClone(input.targets),
    cases: input.targets.map((target) => ({
      target,
      pluginResult: target.kind === 'video'
        ? { code: target.code, title: 'Title', coverUrl: 'https://example.test/cover.jpg' }
        : { mainName: target.mainName, aliases: target.aliases, sourceUrl: 'https://example.test/profile' },
      effectiveResult: target.kind === 'video'
        ? { code: target.code, title: 'Title' }
        : { mainName: target.mainName },
      manifestCoverage: target.kind === 'video'
        ? {
            returnedFieldIds: ['title', 'cover'],
            undeclaredReturnedFieldIds: ['cover'],
            runtimeOnlyKeys: []
          }
        : {
            returnedFieldIds: ['aliases'],
            undeclaredReturnedFieldIds: ['aliases'],
            runtimeOnlyKeys: [
              { key: 'mainName', role: 'identity' },
              { key: 'sourceUrl', role: 'diagnostic' }
            ]
          },
      unrecognizedResultKeys: target.kind === 'video' ? ['legacyCover'] : [],
      logs: ['runtime complete'],
      runtimeAccepted: true
    })),
    executionPassed: true,
    reportPath: path.join(input.reportsDirectory, 'runtime.json')
  }
}

describe('PluginDeveloper v13 tool executor', { concurrency: false }, () => {
  it('rejects removed domain tools', async () => {
    const session = createWorkspaceSession('executor-removed-tools')
    try {
      for (const tool of ['plugin_check', 'plugin_test', 'plugin_finish', 'plugin_install']) {
        const result = await executeTool(session.id, tool, '{}', 1)
        assert.equal(result.ok, false)
        assert.match(result.content, /UNKNOWN_TOOL/)
      }
    } finally {
      deleteSession(session.id)
    }
  })

  it('rejects URL-shaped targets without replacing the initial dry-run state', async () => {
    const session = createWorkspaceSession('executor-invalid-target', 'actress', [])
    const originalRun = pluginExecution.run
    let calls = 0
    pluginExecution.run = async (input) => {
      calls += 1
      return fakeArtifact(input)
    }
    try {
      const result = await executeTool(session.id, 'plugin_dry_run', JSON.stringify({
        actresses: [{ mainName: 'https://xslist.org/zh/model/7.html' }]
      }), 1)
      assert.equal(result.ok, false)
      assert.match(result.content, /RUN_TARGET_INVALID/)
      assert.equal(calls, 0)
      assert.deepEqual(session.runTargets, [])
      assert.deepEqual(
        JSON.parse(fs.readFileSync(
          path.join(session.workspaceDirectory!, '.javdex', 'latest-dry-run.json'),
          'utf8'
        )),
        {
          schemaVersion: 2,
          status: 'not_run',
          currentAcceptance: { installReady: false, reasons: ['missing_execution'] }
        }
      )
    } finally {
      pluginExecution.run = originalRun
      deleteSession(session.id)
    }
  })

  it('preserves the prior latest facts while the workspace is temporarily invalid', async () => {
    const session = createWorkspaceSession('executor-invalid-workspace', 'video', ['ABC-1'])
    const latestPath = path.join(session.workspaceDirectory!, '.javdex', 'latest-dry-run.json')
    pluginWorkspace.recordLatestDryRun(session.workspaceDirectory!, {
      schemaVersion: 2,
      status: 'completed',
      artifactHash: 'previous-artifact',
      reportPath: '/previous/report.json',
      scope: 'all',
      runtimeVersion: PLUGIN_RUNTIME_VERSION,
      targetFingerprint: 'previous-targets',
      executionPassed: true,
      cases: [],
      currentAcceptance: { installReady: true, reasons: [] }
    })
    fs.writeFileSync(path.join(session.workspaceDirectory!, 'plugin.json'), '{ broken', 'utf8')
    try {
      const result = await executeTool(session.id, 'plugin_dry_run', '{}', 2)
      assert.equal(result.ok, false)
      assert.match(result.content, /WORKSPACE_INVALID/)
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as {
        artifactHash?: string
        currentAcceptance?: unknown
      }
      assert.equal(latest.artifactHash, 'previous-artifact')
      assert.deepEqual(latest.currentAcceptance, {
        installReady: false,
        reasons: ['workspace_invalid']
      })
    } finally {
      deleteSession(session.id)
    }
  })

  it('adopts the first legal explicit targets immediately and exposes runtime facts', async () => {
    const session = createWorkspaceSession('executor-adopt-targets', 'video', [])
    const originalRun = pluginExecution.run
    const restoreBrowser = installFakeBrowserLease()
    pluginExecution.run = async (input) => fakeArtifact(input)
    try {
      const result = await executeTool(session.id, 'plugin_dry_run', JSON.stringify({
        videoCodes: ['YST-222']
      }), 2)
      const payload = JSON.parse(result.content) as {
        scope?: string
        cases?: Array<{ unrecognizedResultKeys?: string[] }>
      }
      assert.equal(result.structured?.adoptedTargets, true)
      assert.deepEqual(session.runTargets, [{ kind: 'video', code: 'YST-222' }])
      assert.equal(result.events?.some((event) => event.type === 'run_targets_updated'), true)
      assert.match(result.content, /pluginResult/)
      assert.match(result.content, /effectiveResult/)
      assert.match(result.content, /manifestCoverage/)
      assert.match(result.content, /undeclaredReturnedFieldIds/)
      assert.deepEqual(payload.cases?.[0]?.unrecognizedResultKeys, ['legacyCover'])
      assert.equal(payload.scope, 'all')
      assert.equal(result.structured?.mechanicalAcceptance instanceof Object, true)
      assert.equal(Object.hasOwn(result.structured ?? {}, 'ready'), false)
      assert.equal(Object.hasOwn(result.structured ?? {}, 'attempt'), false)
      const task = JSON.parse(fs.readFileSync(path.join(session.workspaceDirectory!, 'task.json'), 'utf8'))
      assert.deepEqual(task.runTargets, [{ kind: 'video', code: 'YST-222' }])
      const latest = JSON.parse(fs.readFileSync(
        path.join(session.workspaceDirectory!, '.javdex', 'latest-dry-run.json'),
        'utf8'
      )) as Record<string, unknown>
      assert.equal(latest.status, 'completed')
      assert.equal(latest.artifactHash, session.lastExecution?.artifactHash)
      assert.equal(latest.scope, 'all')
      assert.deepEqual(latest.currentAcceptance, { installReady: true, reasons: [] })
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      restoreBrowser()
      pluginExecution.run = originalRun
      deleteSession(session.id)
    }
  })

  it('emits adopted targets before the production runner settles', async () => {
    const session = createWorkspaceSession('executor-adopt-targets-live', 'video', [])
    const originalRun = pluginExecution.run
    const restoreBrowser = installFakeBrowserLease()
    const emitted: string[] = []
    pluginExecution.run = async (input) => {
      assert.deepEqual(emitted, ['run_targets_updated'])
      return fakeArtifact(input)
    }
    try {
      const result = await executeTool(
        session.id,
        'plugin_dry_run',
        JSON.stringify({ videoCodes: ['YST-222'] }),
        2,
        { emit: (event) => emitted.push(event.type) }
      )
      assert.equal(result.ok, true)
      assert.equal(result.events?.some((event) => event.type === 'run_targets_updated'), false)
      assert.deepEqual(emitted, ['run_targets_updated'])
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      restoreBrowser()
      pluginExecution.run = originalRun
      deleteSession(session.id)
    }
  })

  it('replaces session targets after a full unmatched execution', async () => {
    const session = createWorkspaceSession('executor-replace-unmatched', 'video', ['SHKD-999'])
    const originalRun = pluginExecution.run
    const restoreBrowser = installFakeBrowserLease()
    pluginExecution.run = async (input) => fakeArtifact(input)
    try {
      session.lastExecution = {
        runtimeVersion: PLUGIN_RUNTIME_VERSION,
        artifactHash: pluginArtifactHash(session.package),
        targetFingerprint: pluginRunTargetFingerprint(session.runTargets),
        scope: 'all',
        targets: structuredClone(session.runTargets),
        cases: session.runTargets.map((target) => ({
          target,
          pluginResult: null,
          effectiveResult: null,
          manifestCoverage: { returnedFieldIds: [], undeclaredReturnedFieldIds: [], runtimeOnlyKeys: [] },
          unrecognizedResultKeys: [],
          logs: [],
          error: PLUGIN_UNMATCHED_TARGET_ERROR,
          runtimeAccepted: false
        })),
        executionPassed: false,
        reportPath: path.join(session.workspaceDirectory!, '.javdex', 'reports', 'empty.json')
      }
      const result = await executeTool(session.id, 'plugin_dry_run', JSON.stringify({
        videoCodes: ['SHKD-996']
      }), 2)
      const payload = JSON.parse(result.content) as {
        scope?: string
        mechanicalAcceptance?: { installReady?: boolean }
      }
      assert.equal(result.structured?.adoptedTargets, true)
      assert.deepEqual(session.runTargets, [{ kind: 'video', code: 'SHKD-996' }])
      assert.equal(payload.scope, 'all')
      assert.equal(payload.mechanicalAcceptance?.installReady, true)
      assert.equal(result.events?.some((event) => event.type === 'run_targets_updated'), true)
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      restoreBrowser()
      pluginExecution.run = originalRun
      deleteSession(session.id)
    }
  })

  it('keeps later explicit targets targeted when the last full run was not an empty miss', async () => {
    const session = createWorkspaceSession('executor-no-replace-invalid', 'video', ['SHKD-999'])
    const originalRun = pluginExecution.run
    const restoreBrowser = installFakeBrowserLease()
    pluginExecution.run = async (input) => fakeArtifact(input)
    try {
      session.lastExecution = {
        runtimeVersion: PLUGIN_RUNTIME_VERSION,
        artifactHash: pluginArtifactHash(session.package),
        targetFingerprint: pluginRunTargetFingerprint(session.runTargets),
        scope: 'all',
        targets: structuredClone(session.runTargets),
        cases: session.runTargets.map((target) => ({
          target,
          pluginResult: null,
          effectiveResult: null,
          manifestCoverage: { returnedFieldIds: [], undeclaredReturnedFieldIds: [], runtimeOnlyKeys: [] },
          unrecognizedResultKeys: [],
          logs: [],
          error: '插件返回结果格式无效',
          runtimeAccepted: false
        })),
        executionPassed: false,
        reportPath: path.join(session.workspaceDirectory!, '.javdex', 'reports', 'invalid.json')
      }
      const result = await executeTool(session.id, 'plugin_dry_run', JSON.stringify({
        videoCodes: ['SHKD-996']
      }), 2)
      assert.equal(result.structured?.adoptedTargets, false)
      assert.deepEqual(session.runTargets, [{ kind: 'video', code: 'SHKD-999' }])
      assert.deepEqual(result.structured?.mechanicalAcceptance, {
        installReady: false,
        reasons: ['execution_failed', 'wrong_scope', 'target_mismatch']
      })
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      restoreBrowser()
      pluginExecution.run = originalRun
      deleteSession(session.id)
    }
  })

  it('uses later explicit targets only for targeted diagnostics', async () => {
    const session = createWorkspaceSession('executor-targeted-scope', 'video', ['ABC-1', 'ABC-2'])
    const originalRun = pluginExecution.run
    const restoreBrowser = installFakeBrowserLease()
    const scopes: string[] = []
    pluginExecution.run = async (input) => {
      scopes.push(input.scope)
      return fakeArtifact(input)
    }
    try {
      const targeted = await executeTool(session.id, 'plugin_dry_run', JSON.stringify({
        videoCodes: ['ABC-1']
      }), 2)
      assert.deepEqual(targeted.structured?.mechanicalAcceptance, {
        installReady: false,
        reasons: ['execution_failed', 'wrong_scope', 'target_mismatch']
      })
      assert.deepEqual(session.runTargets, [
        { kind: 'video', code: 'ABC-1' },
        { kind: 'video', code: 'ABC-2' }
      ])
      const full = await executeTool(session.id, 'plugin_dry_run', '{}', 3)
      assert.deepEqual(full.structured?.mechanicalAcceptance, { installReady: true, reasons: [] })
      const fullExplicit = await executeTool(session.id, 'plugin_dry_run', JSON.stringify({
        videoCodes: ['ABC-1', 'ABC-2']
      }), 4)
      assert.deepEqual(fullExplicit.structured?.mechanicalAcceptance, { installReady: true, reasons: [] })
      assert.equal(fullExplicit.structured?.adoptedTargets, false)
      assert.deepEqual(scopes, ['targeted', 'all', 'all'])
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      restoreBrowser()
      pluginExecution.run = originalRun
      deleteSession(session.id)
    }
  })

  it('treats explicit targets that cover the session set as a full run', async () => {
    const session = createWorkspaceSession('executor-cover-session-set', 'video', ['HMN-893'])
    const originalRun = pluginExecution.run
    const restoreBrowser = installFakeBrowserLease()
    const scopes: string[] = []
    pluginExecution.run = async (input) => {
      scopes.push(input.scope)
      return fakeArtifact(input)
    }
    try {
      const result = await executeTool(session.id, 'plugin_dry_run', JSON.stringify({
        videoCodes: ['HMN-893']
      }), 2)
      const payload = JSON.parse(result.content) as {
        scope?: string
        mechanicalAcceptance?: { installReady?: boolean; reasons?: string[] }
      }
      assert.equal(result.structured?.adoptedTargets, false)
      assert.deepEqual(session.runTargets, [{ kind: 'video', code: 'HMN-893' }])
      assert.equal(payload.scope, 'all')
      assert.deepEqual(payload.mechanicalAcceptance, { installReady: true, reasons: [] })
      assert.deepEqual(scopes, ['all'])
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      restoreBrowser()
      pluginExecution.run = originalRun
      deleteSession(session.id)
    }
  })

  it('allows the fourth and tenth real executions without an attempt limit', async () => {
    const session = createWorkspaceSession('executor-run-limit', 'video', ['ABC-1'])
    const originalRun = pluginExecution.run
    const restoreBrowser = installFakeBrowserLease()
    let calls = 0
    pluginExecution.run = async (input) => {
      calls += 1
      return fakeArtifact(input)
    }
    try {
      let result
      for (let index = 1; index <= 10; index += 1) {
        result = await executeTool(session.id, 'plugin_dry_run', '{}', index)
        assert.equal(result.ok, true)
        assert.doesNotMatch(result.content, /DRY_RUN_LIMIT_REACHED|remainingAttempts|maxAttempts/)
      }
      assert.equal(result?.structured?.mechanicalAcceptance instanceof Object, true)
      assert.equal(calls, 10)
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      restoreBrowser()
      pluginExecution.run = originalRun
      deleteSession(session.id)
    }
  })

  it('reads an artifact section without acquiring the live browser lease', async () => {
    const session = createWorkspaceSession('executor-read-section', 'video', ['ABC-1'])
    const originalAcquire = scrapeBrowser.acquire
    let acquireCalls = 0
    const artifactRef = path.join('.javdex', 'browser', 'section.json')
    const artifactPath = path.join(session.workspaceDirectory!, artifactRef)
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
    fs.writeFileSync(artifactPath, `${JSON.stringify({
      schemaVersion: 2,
      observation: {
        pageFacts: {
          links: [{ text: 'ABC-1', href: 'https://example.test/ABC-1' }]
        }
      }
    }, null, 2)}\n`, 'utf8')
    scrapeBrowser.acquire = async () => {
      acquireCalls += 1
      throw new Error('read-section must not acquire a browser lease')
    }
    try {
      const result = await executeTool(session.id, 'browser', JSON.stringify({
        action: 'read-section',
        artifactRef,
        section: 'links'
      }), 2)
      const payload = JSON.parse(result.content) as {
        complete?: boolean
        entries?: Array<{ value?: unknown }>
      }

      assert.equal(result.ok, true)
      assert.equal(acquireCalls, 0)
      assert.equal(payload.complete, true)
      assert.deepEqual(payload.entries?.[0]?.value, {
        text: 'ABC-1',
        href: 'https://example.test/ABC-1'
      })
    } finally {
      scrapeBrowser.acquire = originalAcquire
      deleteSession(session.id)
    }
  })

  it('terminates on browser busy without replacing the initial dry-run state', async () => {
    const session = createWorkspaceSession('executor-browser-busy')
    const restoreBrowser = installFakeBrowserLease()
    scrapeBrowser.acquire = async () => {
      throw new ScrapeBrowserBusyError({ ownerId: 'scrape-run', purpose: 'scrape' })
    }
    try {
      const result = await executeTool(session.id, 'plugin_dry_run', '{}', 2)
      assert.equal(result.ok, false)
      assert.match(result.content, /SCRAPE_BROWSER_BUSY/)
      assert.equal(result.waitForUser?.includes('用户继续'), true)
      assert.deepEqual(
        JSON.parse(fs.readFileSync(
          path.join(session.workspaceDirectory!, '.javdex', 'latest-dry-run.json'),
          'utf8'
        )),
        {
          schemaVersion: 2,
          status: 'not_run',
          currentAcceptance: { installReady: false, reasons: ['missing_execution'] }
        }
      )
    } finally {
      restoreBrowser()
      deleteSession(session.id)
    }
  })

  it('does not replace the initial dry-run state when Cloudflare interrupts the run', async () => {
    const session = createWorkspaceSession('executor-cloudflare', 'video', ['ABC-1'])
    const originalRun = pluginExecution.run
    const restoreBrowser = installFakeBrowserLease()
    pluginExecution.run = async (input) => ({
      ...fakeArtifact(input),
      cases: input.targets.map((target) => ({
        target,
        pluginResult: null,
        effectiveResult: null,
        manifestCoverage: {
          returnedFieldIds: [],
          undeclaredReturnedFieldIds: [],
          runtimeOnlyKeys: []
        },
        logs: [],
        error: '验证超时：请完成 Cloudflare 验证',
        runtimeAccepted: false
      })),
      executionPassed: false
    })
    try {
      const result = await executeTool(session.id, 'plugin_dry_run', '{}', 2)
      assert.equal(result.structured?.code, 'BROWSER_CHALLENGE_INTERRUPTED')
      assert.equal(result.waitForUser?.includes('继续 Agent'), true)
      assert.equal(session.lastExecution, undefined)
      assert.deepEqual(
        JSON.parse(fs.readFileSync(
          path.join(session.workspaceDirectory!, '.javdex', 'latest-dry-run.json'),
          'utf8'
        )),
        {
          schemaVersion: 2,
          status: 'not_run',
          currentAcceptance: { installReady: false, reasons: ['missing_execution'] }
        }
      )
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      restoreBrowser()
      pluginExecution.run = originalRun
      deleteSession(session.id)
    }
  })

  it('preserves the prior latest facts when a real execution is cancelled', async () => {
    const session = createWorkspaceSession('executor-cancelled', 'video', ['ABC-1'])
    const originalRun = pluginExecution.run
    const restoreBrowser = installFakeBrowserLease()
    const controller = new AbortController()
    const latestPath = path.join(session.workspaceDirectory!, '.javdex', 'latest-dry-run.json')
    pluginWorkspace.recordLatestDryRun(session.workspaceDirectory!, {
      schemaVersion: 2,
      status: 'completed',
      artifactHash: 'previous-artifact',
      reportPath: '/previous/report.json',
      scope: 'all',
      runtimeVersion: PLUGIN_RUNTIME_VERSION,
      targetFingerprint: 'previous-targets',
      executionPassed: true,
      cases: [],
      currentAcceptance: { installReady: true, reasons: [] }
    })
    let calls = 0
    pluginExecution.run = async (input) => {
      calls += 1
      controller.abort(new Error('用户取消 dry-run'))
      input.signal.throwIfAborted()
      return fakeArtifact(input)
    }
    try {
      await assert.rejects(
        executeTool(session.id, 'plugin_dry_run', '{}', 2, { signal: controller.signal }),
        /用户取消 dry-run/
      )
      assert.equal(calls, 1)
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as { artifactHash?: string }
      assert.equal(latest.artifactHash, 'previous-artifact')
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      restoreBrowser()
      pluginExecution.run = originalRun
      deleteSession(session.id)
    }
  })
})
