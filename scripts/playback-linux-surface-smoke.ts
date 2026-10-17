// Development X11/GLX integration only. No media, user profile, published package,
// hardware decoder, audio device, or operating-system screen reader is exercised.
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { createLinuxPlaybackBridge } from '../apps/desktop/src/main/player/linuxPlaybackBridge'

interface HostReply { parent: number; children: number; video: number; hit: number; focus: number; sent: boolean }
async function run(): Promise<void> {
  assert.equal(process.platform, 'linux')
  assert.ok(process.env.DISPLAY, 'Run under an isolated X11 display such as xvfb-run')
  const [helper, fixture] = process.argv.slice(2)
  assert.ok(helper && fixture, 'Pass the built playback-helper and x11-surface-test')
  const host = spawn(fixture, ['--host'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: host.stdout })
  const replies: HostReply[] = []
  let hostFailure: Error | undefined
  host.on('error', error => { hostFailure = error })
  host.stdin.on('error', error => { hostFailure = error })
  host.on('exit', (code, signal) => {
    if (code !== 0 || signal) hostFailure = new Error(`X11 fixture exited unexpectedly (${signal ?? code})`)
  })
  host.stderr.on('data', () => {})
  lines.on('line', line => { try { replies.push(JSON.parse(line)) } catch { hostFailure = new Error('Invalid X11 fixture reply') } })
  const bridge = createLinuxPlaybackBridge(helper)
  let parentDestroyed = false
  const teardown: { failure: 'native' | 'unexpected' | null } = { failure: null }
  let helperProcess: ChildProcessWithoutNullStreams | undefined
  let helperExit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  let helperOutput = ''
  const observeOutput = (data: Buffer | string): void => {
    helperOutput += data.toString()
    for (;;) {
      const end = helperOutput.indexOf('\n')
      if (end < 0) break
      const line = helperOutput.slice(0, end); helperOutput = helperOutput.slice(end + 1)
      try {
        const state = JSON.parse(line)
        if (parentDestroyed && state.alive === false && state.error != null && state.error !== '') {
          if (typeof state.error !== 'string' || state.errorKind !== 'native') teardown.failure = 'unexpected'
          else if (teardown.failure !== 'unexpected') teardown.failure = 'native'
        }
      } catch { /* The production bridge independently rejects malformed states. */ }
    }
  }
  // Observe the real child lifecycle without adding a test-only production API
  // or replacing spawn. A cached inactive snapshot alone cannot certify exit.
  const processes = channel('child_process')
  const observeProcess = (message: unknown): void => {
    const child = (message as { process: ChildProcessWithoutNullStreams }).process
    // The channel fires at construction, before spawnfile/stdio are assigned.
    child.once('spawn', () => {
      if (child.spawnfile !== helper) return
      if (helperProcess) { hostFailure = new Error('Unexpected duplicate playback helper'); return }
      helperProcess = child
      child.stdout.on('data', observeOutput)
      child.once('exit', (code, signal) => { helperExit = { code, signal } })
    })
  }
  processes.subscribe(observeProcess)
  async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, description: string): Promise<T> {
    const deadline = Date.now() + 10000
    for (;;) {
      if (hostFailure) throw hostFailure
      const value = await read()
      if (done(value)) return value
      assert.ok(Date.now() < deadline, description)
      await delay(20)
    }
  }
  async function reply(command?: string): Promise<HostReply> {
    if (command) host.stdin.write(command + '\n')
    return until(() => replies.shift(), (value): value is HostReply => value != null, 'X11 host did not reply') as Promise<HostReply>
  }
  try {
    const { parent } = await reply()
    const handle = Buffer.alloc(4); handle.writeUInt32LE(parent)
    bridge.create(handle, { x: 0, y: 0, width: 800, height: 600, scale: 1 }, { backend: 'x11' })
    await until(() => helperProcess, value => value != null, 'the real helper process must be observed before accepting its exit')
    bridge.setRendererControls(true)
    bridge.setPresentation('fullscreen'); bridge.setVisible(true)
    await until(() => bridge.state(), state => state.alive && state.rendererFullscreenControls === true, 'real helper did not enable renderer controls')
    const initial = await reply('probe 400 300')
    assert.equal(initial.children, 1, 'there must be no competing native toolbar')
    assert.equal(initial.hit, initial.video)
    bridge.setOcclusions([{ x: 0, y: 500, width: 800, height: 100 }, { x: 100, y: 100, width: 200, height: 200, radii: [20, 20, 20, 20] }])
    await until(() => reply('probe 400 550'), value => value.hit === 0, 'shared controls must receive pointer input through the native surface')
    assert.equal((await reply('probe 200 200')).hit, 0, 'settings/popups must receive input')
    assert.equal((await reply('probe 100 100')).hit, initial.video, 'rounded corners must retain native video pixels/input')
    assert.equal((await reply('probe 400 300')).hit, initial.video, 'unoccluded video must remain active')
    for (const [shift, expected] of [[0, 'focus-forward'], [1, 'focus-backward']] as const) {
      assert.equal((await reply(`key Tab ${shift}`)).sent, true)
      const snapshot = await until(() => bridge.state(), value => value.actions?.some(action => action.kind === expected) === true, 'native Tab did not return to shared controls')
      assert.equal(snapshot.actions?.filter(action => action.kind === expected).length, 1)
      assert.equal((await reply('probe 400 300')).focus, parent, 'native Tab must return X11 focus to the renderer parent')
    }
    bridge.setOcclusions([])
    await until(() => reply('probe 400 550'), value => value.hit === initial.video, 'hiding controls must restore the complete native surface')
    parentDestroyed = true
    host.stdin.end()
    await until(() => {
      try { return !bridge.state().alive }
      catch (error) {
        if (helperExit?.code === 1 && helperExit.signal === null && teardown.failure === 'native') return true
        throw error
      }
    }, Boolean, 'destroyed parent must retire the native surface or report a bounded native error')
    bridge.destroy()
    const exited = await until(() => helperExit, value => value != null, 'native helper did not exit after parent disposal')
    assert.ok(exited)
    assert.equal(exited.signal, null, 'signals and forced termination must fail the surface smoke')
    assert.ok(exited.code === 0 && teardown.failure === null || exited.code === 1 && teardown.failure === 'native',
      'only clean exit or a reported native error after deliberate parent destruction is accepted')
    console.log(`Actual X11/GLX helper: one child, shared-control and rounded-popup input cutouts, clear, native Tab/Shift+Tab and parent disposal PASS (verified exit ${exited.code}, no signal); software display only`)
  } finally {
    processes.unsubscribe(observeProcess)
    helperProcess?.stdout.off('data', observeOutput)
    bridge.destroy(); host.stdin.end()
    const deadline = Date.now() + 5000
    while (host.exitCode == null && host.signalCode == null && Date.now() < deadline) await delay(20)
    if (host.exitCode == null && host.signalCode == null) host.kill('SIGKILL')
    lines.close()
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
