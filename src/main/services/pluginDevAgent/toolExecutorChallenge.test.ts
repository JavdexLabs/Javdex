import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  ScrapeBrowserActionUncertainError,
  ScrapeBrowserChallengeError,
  ScrapeBrowserObservationPendingError,
  isScrapeBrowserChallengeError,
  scrapeBrowser,
  type AgentBrowserCommand,
  type ScrapeBrowserLease
} from '../../scrapers/scrapeBrowser'
import { createPluginDeveloperToolHandlers } from './toolPack'
import { createSession, deleteSession } from './sessionStore'
import type { PluginDevAgentEvent } from './types'
import { pluginWorkspace } from './pluginWorkspace'
import {
  executeTool,
  releasePluginDeveloperBrowser,
  requiresPluginDeveloperBrowserLease
} from './toolExecutor'

describe('plugin developer Cloudflare handoff', () => {
  it('retains the browser only for current and legacy browser handoff requests', () => {
    assert.equal(requiresPluginDeveloperBrowserLease({
      requestId: 'new',
      type: 'browser_interaction',
      reason: 'login',
      prompt: 'login'
    }), true)
    assert.equal(requiresPluginDeveloperBrowserLease({
      requestId: 'legacy',
      type: 'browser_challenge',
      prompt: 'challenge'
    }), true)
    assert.equal(requiresPluginDeveloperBrowserLease({
      requestId: 'question',
      type: 'freeform',
      prompt: 'question'
    }), false)
  })

  it('recognizes the typed browser challenge signal', () => {
    const error = new ScrapeBrowserChallengeError({
      url: 'https://example.test/challenge',
      title: 'Just a moment...'
    })

    assert.equal(error.code, 'CHALLENGE')
    assert.equal(error.url, 'https://example.test/challenge')
    assert.equal(error.title, 'Just a moment...')
    assert.equal(isScrapeBrowserChallengeError(error), true)
    assert.equal(isScrapeBrowserChallengeError(new Error('CHALLENGE')), false)
  })

  it('turns browser action=open challenge into an immediate waiting_user handoff', async () => {
    const session = createSession({
      mode: 'create',
      kind: 'video',
      siteName: 'challenge-site',
      siteUrl: 'https://example.test',
      supportedFields: ['title'],
      testTargets: ['ABC-123']
    })
    const originalAcquire = scrapeBrowser.acquire
    const previousUserData = process.env.JAVDEX_TEST_USER_DATA
    const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-challenge-handoff-'))
    const events: PluginDevAgentEvent[] = []
    let browserCommand: AgentBrowserCommand | undefined

    try {
      process.env.JAVDEX_TEST_USER_DATA = testUserData
      session.workspaceDirectory = testUserData
      pluginWorkspace.open({
        directory: testUserData,
        task: {
          mode: 'create', kind: 'video', siteName: 'challenge-site',
          siteUrl: 'https://example.test', supportedFields: ['title'], testTargets: ['ABC-123']
        },
        package: session.package
      })
      const lease: ScrapeBrowserLease = {
        ownerId: `plugin-dev:${session.id}`,
        purpose: 'agent-browser',
        fetchPage: async () => '',
        fetchBuffer: async () => Buffer.alloc(0),
        fetchBufferResponse: async () => ({ statusCode: 200, body: Buffer.alloc(0) }),
        pluginAction: async () => ({}),
        presentToUser: async () => ({
          url: 'https://example.test/cdn-cgi/challenge',
          title: 'Just a moment...'
        }),
        agentAction: async (command) => {
          browserCommand = command
          throw new ScrapeBrowserChallengeError({
            url: 'https://example.test/cdn-cgi/challenge',
            title: 'Just a moment...'
          })
        },
        recycle: async () => undefined,
        release: async () => undefined
      }
      scrapeBrowser.acquire = async () => lease

      const handlers = createPluginDeveloperToolHandlers({
        domainSessionId: session.id,
        step: () => 7,
        emit: (event) => events.push(event)
      })
      const browser = handlers.get('browser')
      assert.ok(browser)
      const result = await browser({
        runId: session.id,
        callId: 'cloudflare-handoff',
        args: { action: 'open', url: 'https://example.test' },
        signal: new AbortController().signal,
        progress: () => undefined
      })

      assert.deepEqual(browserCommand, {
        action: 'open',
        url: 'https://example.test'
      })
      assert.equal(result.ok, true, result.content)
      assert.equal(result.terminate, true)
      assert.equal(session.status, 'waiting_user')
      const structured = result.recovery?.structured as Record<string, unknown> | undefined
      assert.equal(structured?.code, 'USER_INPUT_REQUIRED')
      assert.equal(structured?.requestType, 'browser_interaction')
      assert.equal(structured?.reason, 'human_verification')
      assert.match(result.content, /USER_INPUT_REQUIRED/)
      assert.equal(
        typeof result.recovery?.waitForUser === 'string' &&
          result.recovery.waitForUser.includes('人机验证'),
        true
      )
      const requestEvent = events.find((event) => event.type === 'user_input_required')
      assert.equal(requestEvent?.type, 'user_input_required')
      assert.equal(
        requestEvent?.type === 'user_input_required' ? requestEvent.request.type : undefined,
        'browser_interaction'
      )
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      scrapeBrowser.acquire = originalAcquire
      if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
      else process.env.JAVDEX_TEST_USER_DATA = previousUserData
      fs.rmSync(testUserData, { recursive: true, force: true })
      deleteSession(session.id)
    }
  })

  it('presents the helper and creates a typed login handoff without running a Playwright action', async () => {
    const session = createSession({
      mode: 'create',
      kind: 'video',
      siteName: 'login-site',
      siteUrl: 'https://example.test',
      supportedFields: [],
      testTargets: []
    })
    const originalAcquire = scrapeBrowser.acquire
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-login-handoff-'))
    let presented = 0
    let agentActions = 0
    try {
      session.workspaceDirectory = directory
      pluginWorkspace.open({
        directory,
        task: {
          mode: 'create', kind: 'video', siteName: 'login-site',
          siteUrl: 'https://example.test', supportedFields: [], testTargets: []
        },
        package: session.package
      })
      scrapeBrowser.acquire = async () => ({
        ownerId: `plugin-dev:${session.id}`,
        purpose: 'agent-browser',
        fetchPage: async () => '',
        fetchBuffer: async () => Buffer.alloc(0),
        fetchBufferResponse: async () => ({ statusCode: 200, body: Buffer.alloc(0) }),
        pluginAction: async () => ({}),
        agentAction: async (command) => {
          agentActions += 1
          return { action: command.action }
        },
        presentToUser: async () => {
          presented += 1
          return { url: 'https://example.test/login', title: 'Sign in' }
        },
        recycle: async () => undefined,
        release: async () => undefined
      })

      const invalid = await executeTool(
        session.id,
        'browser',
        JSON.stringify({ action: 'handoff', reason: 'password' }),
        3
      )
      assert.equal(invalid.ok, false)
      assert.match(invalid.content, /BROWSER_HANDOFF_REASON_INVALID/)
      assert.equal(presented, 0)

      const result = await executeTool(
        session.id,
        'browser',
        JSON.stringify({ action: 'handoff', reason: 'login' }),
        4
      )

      assert.equal(result.ok, true, result.content)
      assert.equal(presented, 1)
      assert.equal(agentActions, 0)
      assert.equal(session.status, 'waiting_user')
      assert.deepEqual(session.pendingUserRequest, {
        requestId: session.pendingUserRequest?.requestId,
        type: 'browser_interaction',
        reason: 'login',
        prompt: '当前页面需要登录。请只在已保留的浏览器窗口中完成登录，然后点击「我已完成，继续」。不要在对话中发送账号、密码或验证码。',
        url: 'https://example.test/login'
      })
      assert.match(result.content, /不要在对话中发送账号、密码或验证码/)
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      scrapeBrowser.acquire = originalAcquire
      fs.rmSync(directory, { recursive: true, force: true })
      deleteSession(session.id)
    }
  })

  it('returns typed recovery errors for uncertain actions and pending explicit observations', async () => {
    const session = createSession({
      mode: 'create',
      kind: 'video',
      siteName: 'recovery-site',
      siteUrl: 'https://example.test',
      supportedFields: [],
      testTargets: ['ABC-123']
    })
    const originalAcquire = scrapeBrowser.acquire
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-recovery-'))
    let nextError: Error = new ScrapeBrowserActionUncertainError({
      url: 'https://example.test/detail',
      documentRevision: '3:8'
    })
    try {
      session.workspaceDirectory = directory
      pluginWorkspace.open({
        directory,
        task: {
          mode: 'create', kind: 'video', siteName: 'recovery-site',
          siteUrl: 'https://example.test', supportedFields: [], testTargets: ['ABC-123']
        },
        package: session.package
      })
      scrapeBrowser.acquire = async () => ({
        ownerId: `plugin-dev:${session.id}`,
        purpose: 'agent-browser',
        fetchPage: async () => '',
        fetchBuffer: async () => Buffer.alloc(0),
        fetchBufferResponse: async () => ({ statusCode: 200, body: Buffer.alloc(0) }),
        pluginAction: async () => ({}),
        presentToUser: async () => ({ url: 'https://example.test/detail', title: 'Detail' }),
        agentAction: async () => { throw nextError },
        recycle: async () => undefined,
        release: async () => undefined
      })

      const uncertain = await executeTool(
        session.id,
        'browser',
        JSON.stringify({ action: 'click', target: '#detail' }),
        1
      )
      assert.equal(uncertain.ok, false)
      assert.match(uncertain.content, /BROWSER_ACTION_UNCERTAIN/)
      assert.match(uncertain.content, /snapshot_or_status/)

      nextError = new ScrapeBrowserObservationPendingError({
        url: 'https://example.test/detail',
        documentRevision: '3:8'
      })
      const pending = await executeTool(
        session.id,
        'browser',
        JSON.stringify({ action: 'snapshot' }),
        2
      )
      assert.equal(pending.ok, false)
      assert.match(pending.content, /BROWSER_OBSERVATION_PENDING/)
      assert.match(pending.content, /"nextAction": "snapshot"/)
      assert.equal(session.status, 'running')
    } finally {
      await releasePluginDeveloperBrowser(session.id)
      scrapeBrowser.acquire = originalAcquire
      fs.rmSync(directory, { recursive: true, force: true })
      deleteSession(session.id)
    }
  })
})
