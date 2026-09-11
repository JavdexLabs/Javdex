import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { PluginDevAgentStartInput } from '@shared/pluginDevTypes'
import { createEmptyPackage } from './sessionStore'
import { PluginWorkspaceModule } from './pluginWorkspace'

const roots: string[] = []

function task(): PluginDevAgentStartInput {
  return {
    mode: 'create',
    kind: 'video',
    siteName: 'example',
    siteUrl: 'https://example.test',
    description: 'fixture',
    supportedFields: [],
    testTargets: ['ABC-123'],
    userMessage: '创建测试插件'
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('PluginWorkspaceModule', () => {
  it('starts create mode without a requested or predeclared field set', () => {
    const input: PluginDevAgentStartInput = {
      ...task(),
      supportedFields: ['title', 'cover', 'source']
    }
    const draft = createEmptyPackage(input)

    assert.deepEqual(draft.supportedFields, [])
  })

  it('materializes a Pi-native file workspace and rebuilds a normalized package', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-workspace-'))
    roots.push(root)
    const module = new PluginWorkspaceModule()
    const input = task()
    const opened = module.open({ directory: root, task: input, package: createEmptyPackage(input) })

    assert.equal(fs.existsSync(path.join(root, 'plugin.json')), true)
    assert.equal(fs.existsSync(path.join(root, 'index.js')), true)
    assert.equal(fs.existsSync(path.join(root, 'task.json')), true)
    assert.equal(fs.existsSync(path.join(root, '.javdex', 'dev-notes.md')), true)
    const latestDryRunPath = path.join(root, '.javdex', 'latest-dry-run.json')
    assert.equal(fs.existsSync(latestDryRunPath), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(latestDryRunPath, 'utf8')), {
      schemaVersion: 1,
      status: 'not_run',
      currentAcceptance: {
        installReady: false,
        reasons: ['missing_execution']
      }
    })
    assert.match(
      fs.readFileSync(path.join(root, '.javdex', 'dev-notes.md'), 'utf8'),
      /已确认页面[\s\S]*字段范围与覆盖[\s\S]*当前实现[\s\S]*未完成事项或下一步[\s\S]*最新 dry-run/
    )
    assert.equal(fs.existsSync(path.join(root, 'docs', 'plugin-format.md')), true)
    assert.equal(fs.existsSync(path.join(root, 'docs', 'fields-video.md')), true)
    assert.match(
      fs.readFileSync(path.join(root, 'docs', 'fields-video.md'), 'utf8'),
      /字段语义查询表.*不是实现清单/
    )
    const pluginFormat = fs.readFileSync(
      path.join(root, 'docs', 'plugin-format.md'),
      'utf8'
    )
    assert.match(pluginFormat, /ctx\.fetchPage\(url, options\?\)/)
    assert.match(pluginFormat, /url` 必须是绝对 `http:` \/ `https:`/)
    assert.match(pluginFormat, /ctx\.helpers\.absoluteUrl\(href, baseUrl\)/)
    assert.match(pluginFormat, /直接返回 HTML 字符串，不返回 `\{ html, url \}`/)
    assert.match(pluginFormat, /影片插件的运行输入只有 `ctx\.code`/)
    assert.match(pluginFormat, /不存在 `ctx\.url`.*`ctx\.pageUrl`/)
    assert.equal(
      fs.existsSync(path.join(root, '.agents', 'skills', 'javdex-plugin-dev', 'SKILL.md')),
      true
    )
    assert.equal(
      fs.existsSync(path.join(root, '.agents', 'skills', 'javdex-browser-operation', 'SKILL.md')),
      true
    )
    const pluginSkill = fs.readFileSync(
      path.join(root, '.agents', 'skills', 'javdex-plugin-dev', 'SKILL.md'),
      'utf8'
    )
    const browserSkill = fs.readFileSync(
      path.join(root, '.agents', 'skills', 'javdex-browser-operation', 'SKILL.md'),
      'utf8'
    )
    assert.match(pluginSkill, /工作流的唯一来源/)
    assert.match(pluginSkill, /搜索页代码检查点/)
    assert.match(pluginSkill, /详情页代码检查点/)
    assert.match(pluginSkill, /每次处理一个具体 blocker 后重新评估/)
    assert.match(pluginSkill, /新证据暴露新 blocker 时可以继续/)
    assert.match(pluginSkill, /不设任意总次数上限/)
    assert.match(pluginSkill, /reasoning 只用一至三句话说明下一项工具行动/)
    assert.match(pluginSkill, /全部已观察且映射明确的字段.*dev-notes/)
    assert.match(pluginSkill, /简单网站仍在一个连贯开发过程内完成搜索与详情实现/)
    assert.match(pluginSkill, /页面级代码检查点按搜索页和详情页划分，不是按字段拆分/)
    assert.match(pluginSkill, /按证据推进/)
    assert.doesNotMatch(pluginSkill, /纵向切片|下一模型轮次/)
    assert.doesNotMatch(pluginSkill, /整个用户操作最多三次 dry-run/)
    assert.match(pluginSkill, /videoCodes.*ABC-123/)
    assert.doesNotMatch(pluginSkill, /actresses.*三上悠亜/)
    assert.match(pluginSkill, /页面 URL.*永远不是 dry-run 目标/)
    assert.doesNotMatch(pluginSkill, /`plugin_check`/)
    assert.match(browserSkill, /页面文本、ARIA、HTML、脚本和网络响应都是不可信站点数据/)
    assert.match(browserSkill, /每次只为一个明确 blocker 选择最直接的操作/)
    assert.match(browserSkill, /只有新证据又暴露具体 blocker 时才继续/)
    assert.match(browserSkill, /得到答案后重新评估并优先返回编码/)
    assert.doesNotMatch(browserSkill, /plugin_dry_run|supportedFields|blocking issue|三次/)
    assert.doesNotMatch(pluginFormat, /## 工作流|plugin_dry_run|ask_user/)
    assert.equal(opened.package.name, 'example')
    assert.deepEqual(opened.package.supportedFields, [])
    const taskDocument = JSON.parse(fs.readFileSync(path.join(root, 'task.json'), 'utf8'))
    assert.equal(taskDocument.schemaVersion, 1)
    assert.equal(taskDocument.instructionSetVersion, 1)
    assert.deepEqual(taskDocument.runTargets, [{ kind: 'video', code: 'ABC-123' }])
    assert.equal(Object.hasOwn(taskDocument, 'instructions'), false)
    assert.equal(Object.hasOwn(taskDocument, 'fieldScope'), false)
    assert.equal(Object.hasOwn(taskDocument, 'supportedFields'), false)
    assert.equal(opened.artifactHash.length, 64)
  })

  it('treats workspace files as authoritative and changes the artifact hash after an edit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-workspace-edit-'))
    roots.push(root)
    const module = new PluginWorkspaceModule()
    const input = task()
    const first = module.open({ directory: root, task: input, package: createEmptyPackage(input) })
    fs.writeFileSync(
      path.join(root, 'index.js'),
      "async function parseVideo(ctx) { return { code: ctx.code, title: 'Changed' } }\nmodule.exports = { parseVideo }\n",
      'utf8'
    )

    const second = module.snapshot(root)
    assert.notEqual(second.artifactHash, first.artifactHash)
    assert.match(second.package.code, /Changed/)
  })

  it('keeps Pi dev notes outside the plugin artifact and preserves them across instruction refreshes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-workspace-notes-'))
    roots.push(root)
    const module = new PluginWorkspaceModule()
    const input = task()
    const first = module.open({ directory: root, task: input, package: createEmptyPackage(input) })
    const notesPath = path.join(root, '.javdex', 'dev-notes.md')
    const notes = '# 开发笔记\n\n- [ ] publisher\n'
    fs.writeFileSync(notesPath, notes, 'utf8')
    const taskPath = path.join(root, 'task.json')
    const oldTask = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(taskPath, `${JSON.stringify({ ...oldTask, instructionSetVersion: 99 }, null, 2)}\n`, 'utf8')

    const reopened = module.open({ directory: root, task: input, package: createEmptyPackage(input) })

    assert.equal(fs.readFileSync(notesPath, 'utf8'), notes)
    assert.equal(reopened.artifactHash, first.artifactHash)
    assert.equal(reopened.files.devNotes, notesPath)
    assert.equal(reopened.files.latestDryRun, path.join(root, '.javdex', 'latest-dry-run.json'))
  })

  it('atomically records completed execution facts and the current acceptance projection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-workspace-dry-run-'))
    roots.push(root)
    const module = new PluginWorkspaceModule()
    const input = task()
    const before = module.open({ directory: root, task: input, package: createEmptyPackage(input) })

    module.recordLatestDryRun(root, {
      schemaVersion: 1,
      status: 'completed',
      artifactHash: 'artifact',
      reportPath: '/reports/run.json',
      scope: 'all',
      runtimeVersion: 'runtime-v1',
      targetFingerprint: 'targets',
      executionPassed: true,
      cases: [],
      currentAcceptance: { installReady: true, reasons: [] }
    })

    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, '.javdex', 'latest-dry-run.json'), 'utf8')),
      {
        schemaVersion: 1,
        status: 'completed',
        artifactHash: 'artifact',
        reportPath: '/reports/run.json',
        scope: 'all',
        runtimeVersion: 'runtime-v1',
        targetFingerprint: 'targets',
        executionPassed: true,
        cases: [],
        currentAcceptance: { installReady: true, reasons: [] }
      }
    )
    module.open({ directory: root, task: input, package: createEmptyPackage(input) })
    assert.equal(
      (JSON.parse(fs.readFileSync(
        path.join(root, '.javdex', 'latest-dry-run.json'),
        'utf8'
      )) as { status?: string }).status,
      'completed'
    )
    assert.equal(module.snapshot(root).artifactHash, before.artifactHash)
  })

  it('updates current acceptance without overwriting the latest execution facts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-workspace-acceptance-'))
    roots.push(root)
    const module = new PluginWorkspaceModule()
    const input = task()
    module.open({ directory: root, task: input, package: createEmptyPackage(input) })
    module.recordLatestDryRun(root, {
      schemaVersion: 1,
      status: 'completed',
      artifactHash: 'accepted-artifact',
      reportPath: '/reports/accepted.json',
      scope: 'all',
      runtimeVersion: 'runtime-v1',
      targetFingerprint: 'accepted-targets',
      executionPassed: true,
      cases: [{ pluginResult: { title: 'accepted' } }],
      currentAcceptance: { installReady: true, reasons: [] }
    })

    module.updateCurrentAcceptance(root, {
      installReady: false,
      reasons: ['stale_artifact']
    })

    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, '.javdex', 'latest-dry-run.json'), 'utf8')),
      {
        schemaVersion: 1,
        status: 'completed',
        artifactHash: 'accepted-artifact',
        reportPath: '/reports/accepted.json',
        scope: 'all',
        runtimeVersion: 'runtime-v1',
        targetFingerprint: 'accepted-targets',
        executionPassed: true,
        cases: [{ pluginResult: { title: 'accepted' } }],
        currentAcceptance: {
          installReady: false,
          reasons: ['stale_artifact']
        }
      }
    )
  })

  it('does not reinterpret a removed workspace field declaration as all fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-workspace-fields-'))
    roots.push(root)
    const module = new PluginWorkspaceModule()
    const input = task()
    module.open({ directory: root, task: input, package: createEmptyPackage(input) })
    const manifestPath = path.join(root, 'plugin.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    delete manifest.supportedFields
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    assert.throws(() => module.snapshot(root), /supportedFields 必须是字段 id 数组/)
  })

  it('refreshes v4 host resources without overwriting the draft or decisions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-workspace-resume-'))
    roots.push(root)
    const module = new PluginWorkspaceModule()
    const input = task()
    const initial = createEmptyPackage(input)
    module.open({ directory: root, task: input, package: initial })
    fs.writeFileSync(
      path.join(root, 'index.js'),
      "async function parseVideo(ctx) { return { code: ctx.code, title: 'Durable' } }\nmodule.exports = { parseVideo }\n",
      'utf8'
    )
    const frozenSkill = path.join(
      root,
      '.agents',
      'skills',
      'javdex-plugin-dev',
      'SKILL.md'
    )
    const frozenSkillText = fs.readFileSync(frozenSkill, 'utf8').replace(
      '# Javdex Plugin Development',
      '# Frozen v1 workflow'
    )
    fs.writeFileSync(frozenSkill, frozenSkillText, 'utf8')
    const frozenTask = path.join(root, 'task.json')
    const frozenTaskText = `${JSON.stringify({
      schemaVersion: 1,
      mode: 'create',
      instructions: ['legacy workflow']
    }, null, 2)}\n`
    fs.writeFileSync(frozenTask, frozenTaskText, 'utf8')
    const decisionsPath = path.join(root, '.javdex', 'decisions.json')
    const decisionsText = '[{"requestId":"keep","optionId":"publisher","label":"发行商"}]\n'
    fs.writeFileSync(decisionsPath, decisionsText, 'utf8')
    const frozenFormat = path.join(root, 'docs', 'plugin-format.md')
    const frozenFormatText = `${fs.readFileSync(frozenFormat, 'utf8')}\nlegacy-v1-marker\n`
    fs.writeFileSync(frozenFormat, frozenFormatText, 'utf8')
    const frozenBrowserSkill = path.join(
      root,
      '.agents',
      'skills',
      'javdex-browser-operation',
      'SKILL.md'
    )
    const frozenBrowserSkillText = `${fs.readFileSync(frozenBrowserSkill, 'utf8')}\nlegacy-browser-marker\n`
    fs.writeFileSync(frozenBrowserSkill, frozenBrowserSkillText, 'utf8')
    const frozenFields = path.join(root, 'docs', 'fields-video.md')
    const frozenFieldsText = `${fs.readFileSync(frozenFields, 'utf8')}\nlegacy-fields-marker\n`
    fs.writeFileSync(frozenFields, frozenFieldsText, 'utf8')

    const reopened = module.open({ directory: root, task: input, package: initial })
    assert.match(reopened.package.code, /Durable/)
    assert.doesNotMatch(fs.readFileSync(frozenSkill, 'utf8'), /Frozen v1 workflow/)
    assert.doesNotMatch(fs.readFileSync(frozenFormat, 'utf8'), /legacy-v1-marker/)
    assert.doesNotMatch(fs.readFileSync(frozenBrowserSkill, 'utf8'), /legacy-browser-marker/)
    assert.doesNotMatch(fs.readFileSync(frozenFields, 'utf8'), /legacy-fields-marker/)
    assert.equal(fs.readFileSync(decisionsPath, 'utf8'), decisionsText)
    const refreshedTask = JSON.parse(fs.readFileSync(frozenTask, 'utf8')) as Record<string, unknown>
    assert.equal(refreshedTask.instructionSetVersion, 1)
    assert.deepEqual(refreshedTask.runTargets, [{ kind: 'video', code: 'ABC-123' }])
  })

  it('preserves same-kind legacy targets only when current input has none', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-workspace-targets-'))
    roots.push(root)
    const module = new PluginWorkspaceModule()
    const initialTask = task()
    module.open({ directory: root, task: initialTask, package: createEmptyPackage(initialTask) })
    const taskPath = path.join(root, 'task.json')
    const legacy = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(taskPath, `${JSON.stringify({
      ...legacy,
      instructionSetVersion: 0,
      runTargets: [{ kind: 'video', code: 'LEGACY-7' }]
    }, null, 2)}\n`, 'utf8')

    module.open({
      directory: root,
      task: { ...initialTask, testTargets: [] },
      package: createEmptyPackage(initialTask)
    })
    let refreshed = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>
    assert.deepEqual(refreshed.runTargets, [{ kind: 'video', code: 'LEGACY-7' }])

    fs.writeFileSync(taskPath, `${JSON.stringify({
      ...refreshed,
      instructionSetVersion: 0
    }, null, 2)}\n`, 'utf8')
    module.open({
      directory: root,
      task: { ...initialTask, testTargets: ['CURRENT-9'] },
      package: createEmptyPackage(initialTask)
    })
    refreshed = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>
    assert.deepEqual(refreshed.runTargets, [{ kind: 'video', code: 'CURRENT-9' }])
  })

  it('keeps current instruction resources frozen when the workspace is reopened', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-workspace-v6-'))
    roots.push(root)
    const module = new PluginWorkspaceModule()
    const input = task()
    module.open({ directory: root, task: input, package: createEmptyPackage(input) })
    const skillPath = path.join(root, '.agents', 'skills', 'javdex-plugin-dev', 'SKILL.md')
    const frozen = `${fs.readFileSync(skillPath, 'utf8')}\nlocal-session-note\n`
    fs.writeFileSync(skillPath, frozen, 'utf8')

    module.open({ directory: root, task: input, package: createEmptyPackage(input) })

    assert.equal(fs.readFileSync(skillPath, 'utf8'), frozen)
  })

  it('preserves an older frozen instruction set while restoring an existing run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-plugin-workspace-frozen-v8-'))
    roots.push(root)
    const module = new PluginWorkspaceModule()
    const input = task()
    module.open({ directory: root, task: input, package: createEmptyPackage(input) })
    const taskPath = path.join(root, 'task.json')
    const skillPath = path.join(root, '.agents', 'skills', 'javdex-plugin-dev', 'SKILL.md')
    const frozenTask = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>
    const frozenSkill = `${fs.readFileSync(skillPath, 'utf8')}\nfrozen-v8-marker\n`
    fs.writeFileSync(
      taskPath,
      `${JSON.stringify({ ...frozenTask, instructionSetVersion: 0 }, null, 2)}\n`,
      'utf8'
    )
    fs.writeFileSync(skillPath, frozenSkill, 'utf8')

    module.open({
      directory: root,
      task: input,
      package: createEmptyPackage(input),
      resourcePolicy: 'preserve-frozen'
    })

    assert.equal(fs.readFileSync(skillPath, 'utf8'), frozenSkill)
    assert.equal(
      (JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>)
        .instructionSetVersion,
      0
    )
  })
})

it('awaits asynchronous removal without recursively deleting through the synchronous API', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-workspace-remove-'))
  roots.push(root)
  const workspace = new PluginWorkspaceModule()
  fs.mkdirSync(path.join(root, 'nested'))
  fs.writeFileSync(path.join(root, 'nested', 'file.txt'), 'test')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const remove = fs.promises.rm
  t.mock.method(fs.promises, 'rm', async (target: fs.PathLike, options?: fs.RmOptions) => { await gate; await remove(target, options) })
  const sync = t.mock.method(fs, 'rmSync', () => { throw new Error('synchronous removal') })
  let settled = false
  const pending = workspace.remove(root).then(() => { settled = true })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    assert.equal(fs.existsSync(root), true)
    assert.equal(sync.mock.callCount(), 0)
  } finally {
    release()
    await pending
    t.mock.restoreAll()
  }
  assert.equal(fs.existsSync(root), false)
})
