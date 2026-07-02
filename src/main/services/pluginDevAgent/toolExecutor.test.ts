import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { cleanupSessions, createSession, deleteSession, getSession, hashCode, markSessionEnded } from './sessionStore'
import { executeTool } from './toolExecutor'

import type { VideoScrapeField } from '@shared/types'

const baseInput = {
  mode: 'create' as const,
  kind: 'video' as const,
  siteName: 'test-site',
  supportedFields: ['title', 'maker'] as VideoScrapeField[],
  testTargets: ['ABC-123']
}

let tempRoot: string | null = null
let oldUserData: string | null = null

beforeEach(() => {
  oldUserData = process.env.JAVDEX_TEST_USER_DATA ?? null
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-dev-agent-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
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

describe('pluginDevAgent toolExecutor', () => {
  it('derives a usable plugin name from URL when site name is empty', () => {
    const session = createSession({
      ...baseInput,
      siteName: '',
      siteUrl: 'https://www.tokyolib.com/'
    })
    try {
      assert.equal(session.package.name, 'tokyolib')
      assert.equal(session.siteName, 'tokyolib')
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_get_state returns package summary', async () => {
    const session = createSession(baseInput)
    try {
      const result = await executeTool(session.id, 'plugin_get_state', '{}', 1)
      assert.equal(result.ok, true, result.content)
      assert.match(result.content, /test-site/)
      assert.match(result.content, /ABC-123/)
      assert.match(result.content, /首次开发（create）：plugin_verify 后会自动新增/)
      assert.match(result.content, /codeOmitted/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_code rejects empty code', async () => {
    const session = createSession(baseInput)
    try {
      const result = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({ mode: 'replace_all', code: '   ' }),
        1
      )
      assert.equal(result.ok, false)
      assert.match(result.content, /不能为空/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_get_state returns package code for incremental edits', async () => {
    const session = createSession(baseInput)
    try {
      const code = `async function parseVideo(ctx) {
  const html = await ctx.fetchPage('https://example.test');
  return { code: ctx.code, title: 'OK' };
}
module.exports = { parseVideo };`
      session.package = { ...session.package, code }
      const result = await executeTool(
        session.id,
        'plugin_get_state',
        JSON.stringify({ includeCode: true }),
        1
      )
      assert.equal(result.ok, true, result.content)
      assert.match(result.content, /fetchPage/)
      assert.match(result.content, /incrementalEditOnly/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_code rejects replace_all when substantial code exists without force', async () => {
    const session = createSession(baseInput)
    try {
      const code = `async function parseVideo(ctx) {
  const html = await ctx.fetchPage('https://example.test');
  return { code: ctx.code, title: 'OK' };
}
module.exports = { parseVideo };`
      session.package = { ...session.package, code }
      const replacement = `async function parseVideo(ctx) {
  return { code: ctx.code, title: 'REPLACED' };
}
module.exports = { parseVideo };`
      const result = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({ mode: 'replace_all', code: replacement }),
        2
      )
      assert.equal(result.ok, false)
      assert.match(result.content, /INCREMENTAL_EDIT_REQUIRED/)
      assert.match(session.package.code, /fetchPage/)
      assert.doesNotMatch(session.package.code, /title: 'REPLACED'/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_code allows forced replace_all with a reason', async () => {
    const session = createSession(baseInput)
    try {
      const code = `async function parseVideo(ctx) {
  const html = await ctx.fetchPage('https://example.test');
  return { code: ctx.code, title: 'OK' };
}
module.exports = { parseVideo };`
      session.package = { ...session.package, code }
      const replacement = `async function parseVideo(ctx) {
  return { code: ctx.code, title: 'REPLACED' };
}
module.exports = { parseVideo };`
      const result = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({
          mode: 'replace_all',
          code: replacement,
          forceWholeRewrite: true,
          forceReason: '需要清理旧 helper 并重组整体结构'
        }),
        2
      )
      assert.equal(result.ok, true, result.content)
      assert.match(result.content, /整包替换/)
      assert.match(session.package.code, /title: 'REPLACED'/)
      assert.doesNotMatch(session.package.code, /fetchPage/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_code rejects unknown mode instead of treating it as replace_all', async () => {
    const session = createSession(baseInput)
    try {
      const before = session.package.code
      const result = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({
          mode: 'replace_everything',
          code: `async function parseVideo(ctx) { return { title: 'BAD' } }`
        }),
        2
      )
      assert.equal(result.ok, false)
      assert.match(result.content, /INVALID_UPDATE_MODE/)
      assert.equal(session.package.code, before)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_code does not persist invalid replace_all code after validation fails', async () => {
    const session = createSession(baseInput)
    try {
      const code = `async function parseVideo(ctx) {
  const html = await ctx.fetchPage('https://example.test');
  return { code: ctx.code, title: 'OK' };
}
module.exports = { parseVideo };`
      session.package = { ...session.package, code }
      const result = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({
          mode: 'replace_all',
          code: `function dup() { return 1 }
function dup() { return 2 }
async function parseVideo(ctx) { return { code: ctx.code } }
module.exports = { parseVideo };`,
          forceWholeRewrite: true,
          forceReason: '需要整体重写但这段代码有重复符号'
        }),
        2
      )
      assert.equal(result.ok, false)
      assert.match(result.content, /重复顶层符号/)
      assert.equal(session.package.code, code)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_code allows replace_function on substantial code', async () => {
    const session = createSession(baseInput)
    try {
      const code = `async function parseVideo(ctx) {
  const html = await ctx.fetchPage('https://example.test');
  return { code: ctx.code, title: 'OLD' };
}
module.exports = { parseVideo };`
      session.package = { ...session.package, code }
      const result = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({
          mode: 'replace_function',
          functionName: 'parseVideo',
          code: `async function parseVideo(ctx) {
  const html = await ctx.fetchPage('https://example.test');
  return { code: ctx.code, title: 'NEW' };
}`
        }),
        2
      )
      assert.equal(result.ok, true, result.content)
      assert.match(session.package.code, /title: 'NEW'/)
      assert.match(session.package.code, /fetchPage/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_code rejects replace_function append when substantial code exists', async () => {
    const session = createSession(baseInput)
    try {
      const code = `function existingHelper() { return 'OK' }
async function parseVideo(ctx) {
  const html = await ctx.fetchPage('https://example.test');
  return { code: ctx.code, title: existingHelper() };
}
module.exports = { parseVideo };`
      session.package = { ...session.package, code }
      const result = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({
          mode: 'replace_function',
          functionName: 'missingHelper',
          code: `function missingHelper() { return 'NEW' }`
        }),
        2
      )
      assert.equal(result.ok, false)
      assert.match(result.content, /FUNCTION_NOT_FOUND/)
      assert.doesNotMatch(session.package.code, /missingHelper/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_code updates package and emits package_updated', async () => {
    const session = createSession(baseInput)
    try {
      const code = `async function parseVideo(ctx) {
  return { code: ctx.code, title: 'OK' };
}
module.exports = { parseVideo };`
      const result = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({ mode: 'replace_all', code }),
        2
      )
      assert.equal(result.ok, true, result.content)
      assert.match(session.package.code, /title: 'OK'/)
      assert.equal(result.events?.some((event) => event.type === 'package_updated'), true)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_dry_run can override the video test target for the current run', async () => {
    const session = createSession({
      ...baseInput,
      testTargets: undefined
    })
    try {
      const code = `async function parseVideo(ctx) {
  return { code: ctx.code, title: 'OK' };
}
module.exports = { parseVideo };`
      session.package = { ...session.package, code }
      const result = await executeTool(
        session.id,
        'plugin_dry_run',
        JSON.stringify({ testTarget: 'ABC-999' }),
        2
      )
      assert.equal(result.ok, true, result.content)
      assert.deepEqual(session.testTargets, ['ABC-999'])
      assert.equal(session.lastDryRun?.ok, true)
    } finally {
      deleteSession(session.id)
    }
  })

  it('session_note appends page notes', async () => {
    const session = createSession(baseInput)
    try {
      const result = await executeTool(
        session.id,
        'session_note',
        JSON.stringify({ text: '面包屑链接在 metadata 之前' }),
        1
      )
      assert.equal(result.ok, true)
      assert.equal(session.pageNotes.length, 1)
      assert.match(session.pageNotes[0]?.text ?? '', /面包屑/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('session_request_user marks session waiting_user', async () => {
    const session = createSession(baseInput)
    try {
      const result = await executeTool(
        session.id,
        'session_request_user',
        JSON.stringify({ reason: '请完成 Cloudflare 验证' }),
        3
      )
      assert.equal(result.ok, true)
      assert.equal(session.status, 'waiting_user')
      assert.equal(result.waitForUser, '请完成 Cloudflare 验证')
      assert.equal(result.events?.[0]?.type, 'waiting_user')
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_package allows supportedFields in create mode', async () => {
    const session = createSession({
      ...baseInput,
      mode: 'create',
      supportedFields: ['title', 'duration', 'rating', 'samples'] as VideoScrapeField[]
    })
    try {
      const result = await executeTool(
        session.id,
        'plugin_update_package',
        JSON.stringify({ supportedFields: ['title', 'maker'] }),
        1
      )
      assert.equal(result.ok, true)
      assert.deepEqual(session.package.supportedFields, ['title', 'maker'])
      assert.deepEqual(session.supportedFields, ['title', 'maker'])
      assert.equal(session.lastVerification, undefined)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_package preserves verification for supportedFields-only removal proven unsupported', async () => {
    const session = createSession({
      ...baseInput,
      mode: 'create',
      supportedFields: ['title', 'summary'] as VideoScrapeField[]
    })
    try {
      session.lastDryRun = {
        ok: true,
        result: { code: 'ABC-123', title: 'OK' },
        logs: []
      }
      session.lastDryRunCodeHash = hashCode(session.package.code)
      session.lastVerification = {
        summary: '验证通过',
        items: [
          { field: 'title', status: 'ok', note: '标题正确' },
          { field: 'summary', status: 'ok', note: '站点无此字段' }
        ]
      }

      const verification = session.lastVerification
      const result = await executeTool(
        session.id,
        'plugin_update_package',
        JSON.stringify({ supportedFields: ['title'] }),
        1
      )

      assert.equal(result.ok, true)
      assert.match(result.content, /上次语义验证仍有效/)
      assert.deepEqual(session.package.supportedFields, ['title'])
      assert.equal(session.lastVerification, verification)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_package invalidates verification when supportedFields add unverified fields', async () => {
    const session = createSession({
      ...baseInput,
      mode: 'create',
      supportedFields: ['title'] as VideoScrapeField[]
    })
    try {
      session.lastDryRun = {
        ok: true,
        result: { code: 'ABC-123', title: 'OK' },
        logs: []
      }
      session.lastDryRunCodeHash = hashCode(session.package.code)
      session.lastVerification = {
        summary: '验证通过',
        items: [{ field: 'title', status: 'ok', note: '标题正确' }]
      }

      const result = await executeTool(
        session.id,
        'plugin_update_package',
        JSON.stringify({ supportedFields: ['title', 'maker'] }),
        1
      )

      assert.equal(result.ok, true)
      assert.deepEqual(session.package.supportedFields, ['title', 'maker'])
      assert.equal(session.lastVerification, undefined)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_package rejects supportedFields removal in debug mode without user request', async () => {
    const session = createSession({
      ...baseInput,
      mode: 'debug'
    })
    try {
      const result = await executeTool(
        session.id,
        'plugin_update_package',
        JSON.stringify({ supportedFields: ['title'] }),
        1
      )
      assert.equal(result.ok, false)
      assert.match(result.content, /DEBUG_SUPPORTED_FIELDS_REMOVE_LOCKED/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_package allows supportedFields removal in debug mode when user requested', async () => {
    const session = createSession({
      ...baseInput,
      mode: 'debug',
      supportedFields: ['title', 'maker'] as VideoScrapeField[]
    })
    session.lastUserInstruction = '请从支持字段移除 maker'
    try {
      const result = await executeTool(
        session.id,
        'plugin_update_package',
        JSON.stringify({ supportedFields: ['title'], confirmUserRemoval: true }),
        1
      )
      assert.equal(result.ok, true)
      assert.deepEqual(session.package.supportedFields, ['title'])
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_package allows adding supportedFields in debug mode', async () => {
    const session = createSession({
      ...baseInput,
      mode: 'debug',
      supportedFields: ['title'] as VideoScrapeField[]
    })
    try {
      const result = await executeTool(
        session.id,
        'plugin_update_package',
        JSON.stringify({ supportedFields: ['title', 'maker', 'publisher'] }),
        1
      )
      assert.equal(result.ok, true)
      assert.deepEqual(session.package.supportedFields, ['title', 'maker', 'publisher'])
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_code replace_snippet updates a small fragment', async () => {
    const session = createSession(baseInput)
    try {
      const code = `async function parseVideo(ctx) {
  return { code: ctx.code, title: 'OLD' };
}
module.exports = { parseVideo };`
      session.package = { ...session.package, code }
      const result = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({
          mode: 'replace_snippet',
          oldText: "title: 'OLD'",
          newText: "title: 'SNIPPET'"
        }),
        2
      )
      assert.equal(result.ok, true, result.content)
      assert.match(result.content, /replace_snippet/)
      assert.match(session.package.code, /title: 'SNIPPET'/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_get_state includes topLevelFunctions', async () => {
    const session = createSession(baseInput)
    try {
      session.package = {
        ...session.package,
        code: `function buildUrl(code) { return 'https://x/' + code }
async function parseVideo(ctx) { return { code: ctx.code, title: 'OK' } }
module.exports = { parseVideo }`
      }
      const result = await executeTool(session.id, 'plugin_get_state', '{}', 1)
      assert.equal(result.ok, true, result.content)
      assert.match(result.content, /topLevelFunctions/)
      assert.match(result.content, /buildUrl/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_update_code replace_function can replace a helper by name', async () => {
    const session = createSession({
      ...baseInput,
      kind: 'actress',
      supportedFields: ['profileSummary']
    })
    try {
      session.package = {
        ...session.package,
        kind: 'actress',
        code: `function summarize(text) { return text.slice(0, 3) }
async function parseActress(ctx) {
  return { mainName: ctx.mainName, profileSummary: summarize('hello') }
}
module.exports = { parseActress }`
      }
      const result = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({
          mode: 'replace_function',
          functionName: 'summarize',
          code: `function summarize(text) { return text.slice(0, 5) }`
        }),
        2
      )
      assert.equal(result.ok, true, result.content)
      assert.match(session.package.code, /slice\(0, 5\)/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_verify rejects stale dry-run after code change', async () => {
    const session = createSession(baseInput)
    try {
      session.lastDryRun = {
        ok: true,
        result: { code: 'ABC-123', title: '示例', maker: 'Muku' },
        logs: []
      }
      session.lastDryRunCodeHash = hashCode(session.package.code)
      session.lastVerification = {
        summary: '旧验证',
        items: [{ field: 'maker', status: 'suspicious', note: '制作商错误' }]
      }

      const codeResult = await executeTool(
        session.id,
        'plugin_update_code',
        JSON.stringify({
          mode: 'replace_all',
          code: `async function parseVideo(ctx) {
  return { title: '新标题', maker: 'Muku' };
}
module.exports = { parseVideo };`
        }),
        1
      )
      assert.equal(codeResult.ok, true)
      assert.equal(session.lastVerification, undefined)

      const verifyResult = await executeTool(session.id, 'plugin_verify', '{}', 2)
      assert.equal(verifyResult.ok, false)
      assert.match(verifyResult.content, /STALE_DRY_RUN/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_verify rejects failed dry-run before semantic verification', async () => {
    const session = createSession(baseInput)
    try {
      session.lastDryRun = {
        ok: false,
        result: { code: 'ABC-123' },
        error: 'selector failed',
        logs: []
      }
      session.lastDryRunCodeHash = hashCode(session.package.code)

      const verifyResult = await executeTool(session.id, 'plugin_verify', '{}', 2)
      assert.equal(verifyResult.ok, false)
      assert.match(verifyResult.content, /DRY_RUN_FAILED/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('plugin_install is blocked until dry-run and verification pass', async () => {
    const session = createSession(baseInput)
    try {
      session.package = {
        ...session.package,
        name: 'install-gate-test',
        code: `async function parseVideo(ctx) {
  return { code: ctx.code, title: 'OK' };
}
module.exports = { parseVideo };`
      }

      const blocked = await executeTool(session.id, 'plugin_install', '{}', 1)
      assert.equal(blocked.ok, false)
      assert.match(blocked.content, /INSTALL_BLOCKED/)

      session.lastDryRun = {
        ok: true,
        result: { code: 'ABC-123', title: 'OK' },
        logs: []
      }
      session.lastDryRunCodeHash = hashCode(session.package.code)
      session.lastVerification = {
        summary: '验证通过',
        items: [{ field: 'title', status: 'ok', note: '标题正确' }]
      }

      const installed = await executeTool(session.id, 'plugin_install', '{}', 2)
      assert.equal(installed.ok, true, installed.content)
      assert.match(installed.content, /install-gate-test/)
    } finally {
      deleteSession(session.id)
    }
  })

  it('cleanupSessions removes terminal sessions after ttl', () => {
    const session = createSession(baseInput)
    markSessionEnded(session.id, 1000)
    const removedEarly = cleanupSessions(1000 + 30 * 60 * 1000)
    assert.equal(removedEarly, 0)
    assert.ok(getSession(session.id))

    const removedLate = cleanupSessions(1000 + 61 * 60 * 1000)
    assert.equal(removedLate, 1)
    assert.equal(getSession(session.id), undefined)
  })
})
