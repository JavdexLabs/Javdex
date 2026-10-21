import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

function load<T>(file: string, require: (id: string) => unknown, platform = 'linux'): T {
  const exports = {}
  const code = transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  runInNewContext(code, { exports, require, process: { platform } })
  return exports as T
}
test('only explicitly marked packaged Linux builds select experimental identity', () => {
  for (const platform of ['linux', 'darwin', 'win32']) for (const packaged of [false, true]) for (const marker of [false, true, 'true', undefined]) {
    const api = load<typeof import('./experimentalLinuxBuild')>('./experimentalLinuxBuild.ts', id => {
      if (id === 'electron') return { app: { isPackaged: packaged, getAppPath: () => '/app' } }
      if (id === 'node:fs') return { readFileSync: () => JSON.stringify({ javdexExperimentalLinux: marker }) }
      if (id === 'node:path') return path
      throw new Error(id)
    }, platform)
    assert.equal(api.isExperimentalLinuxBuild(), platform === 'linux' && packaged && marker === true)
  }
})
test('experimental default profile cannot silently open the production Javdex directory', () => {
  for (const experimental of [false, true]) {
    const calls: string[][] = []
    const api = load<typeof import('./appPaths')>('./appPaths.ts', id => {
      if (id === 'electron') return { app: { setName: (name: string) => calls.push(['name', name]),
        setPath: (kind: string, value: string) => calls.push([kind, value]), getPath: () => '/config' } }
      if (id === 'node:path') return path
      if (id === './experimentalLinuxBuild') return { isExperimentalLinuxBuild: (name?: string) => experimental && !name,
        EXPERIMENTAL_LINUX_NAME: 'Javdex Linux Texture Experimental', EXPERIMENTAL_LINUX_PROFILE: 'Javdex-Linux-Texture-Experimental' }
      if (id === '@shared/appIdentity') return { APP_DISPLAY_NAME: 'Javdex', APP_PACKAGE_NAME: 'Javdex', readTestUserDataPath: () => undefined }
      throw new Error(id)
    })
    api.configureAppIdentity()
    assert.deepEqual(calls, [['name', experimental ? 'Javdex Linux Texture Experimental' : 'Javdex'],
      ['userData', experimental ? '/config/Javdex-Linux-Texture-Experimental' : '/config/Javdex']])
  }
})
test('experimental update checks and release navigation make no network or external calls', async () => {
  const unexpected = (): never => { throw new Error('Experimental build must not contact release service') }
  const api = load<typeof import('./services/appReleaseService')>('./services/appReleaseService.ts', id => {
    if (id === 'electron') return { app: { getVersion: () => '0.9.1-linux-texture.1' }, shell: { openExternal: unexpected } }
    if (id === 'node:path') return path
    if (id === 'node:fs') return { readFileSync: unexpected }
    if (id === 'axios') return { isAxiosError: () => false }
    if (id === '../utils/http') return { createHttpClient: unexpected }
    if (id === '../settings/settingsStore') return { getSettings: unexpected }
    if (id === '@shared/settingsTypes') return { resolveScrapeProxyUrl: unexpected }
    if (id === '../experimentalLinuxBuild') return { isExperimentalLinuxBuild: () => true }
    throw new Error(id)
  })
  assert.equal(api.shouldRunAutomaticCheck(), false)
  assert.equal((await api.checkForLatestRelease()).errorCode, 'experimental-build')
  assert.equal(await api.openReleasePage(), false)
})

test('portable package identity requires the exact packaged experimental marker and name', () => {
  for (const name of ['javdex-linux-portable-phase1', 'javdex-linux-texture-experimental']) {
    const api = load<typeof import('./experimentalLinuxBuild')>('./experimentalLinuxBuild.ts', id => {
      if (id === 'electron') return { app: { isPackaged: true, getAppPath: () => '/app' } }
      if (id === 'node:fs') return { readFileSync: () => JSON.stringify({ javdexExperimentalLinux: true, name }) }
      if (id === 'node:path') return path
      throw new Error(id)
    })
    assert.equal(api.isExperimentalLinuxBuild('javdex-linux-portable-phase1'), name === 'javdex-linux-portable-phase1')
  }
})
