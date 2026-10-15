import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { loadUpdaterConfig } from './config'
import { businessProcessCommand } from './businessProcess'
import { BusinessSupervisor } from './supervisor'

test('business children use configured supplementary groups for media access, without inheriting manager groups', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0 || spawnSync('setpriv', ['--version']).status !== 0
    ? 'Requires Linux root and util-linux setpriv; run in an isolated container' : false
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-business-groups-'))
  const originalGroups = process.getgroups!()
  const mediaGroup = 22001
  let supervisor: BusinessSupervisor | undefined
  try {
    process.setgroups!([0, mediaGroup]) // Model Docker group_add on the root manager.
    fs.chmodSync(root, 0o755)
    const media = path.join(root, 'media')
    fs.mkdirSync(media)
    fs.chownSync(media, 0, mediaGroup); fs.chmodSync(media, 0o750)
    const file = path.join(media, 'movie.mp4')
    fs.writeFileSync(file, 'synthetic movie')
    fs.chownSync(file, 0, mediaGroup); fs.chmodSync(file, 0o640)
    const inspect = String.raw`const fs=require('node:fs');const result={uid:process.getuid(),gid:process.getgid(),groups:fs.readFileSync('/proc/self/status','utf8').split('\n').find(x=>x.startsWith('Groups:')).slice(7).trim().split(/\s+/).filter(Boolean).map(Number)};try{result.directories=fs.readdirSync(${JSON.stringify(media)});result.movie=fs.readFileSync(${JSON.stringify(file)},'utf8')}catch(e){result.error=e.code}`
    for (const groups of ['', String(mediaGroup)]) {
      const directory = path.join(root, groups ? 'configured' : 'empty')
      fs.mkdirSync(directory, { mode: 0o777 }); fs.chmodSync(directory, 0o777)
      const configFile = path.join(directory, 'server.json')
      fs.writeFileSync(configFile, JSON.stringify({ dataDir: path.join(directory, 'data') }))
      const config = loadUpdaterConfig(configFile, { env: { JAVDEX_RUNTIME_DIR: path.join(directory, 'program'),
        JAVDEX_PUBLIC_URL: 'https://127.0.0.1:8096', JAVDEX_SERVER_UID: '1000', JAVDEX_SERVER_GID: '1000', JAVDEX_SERVER_GROUPS: groups } })
      const report = path.join(directory, 'report.json')
      fs.writeFileSync(path.join(directory, 'index.js'), `${inspect};fs.writeFileSync(${JSON.stringify(report)},JSON.stringify(result));setInterval(()=>{},1000)`)
      supervisor = new BusinessSupervisor(config)
      await supervisor.start(directory)
      const deadline = Date.now() + 5000
      while (!fs.existsSync(report) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      assert.ok(fs.existsSync(report), 'the supervised business process must report its own credentials and media read')
      const assertAccess = (result: { uid: number; gid: number; groups: number[]; movie?: string; error?: string }) => {
        assert.equal(result.uid, 1000); assert.equal(result.gid, 1000)
        assert.deepEqual(result.groups, groups ? [mediaGroup] : [])
        assert.equal(result.error, groups ? undefined : 'EACCES')
        assert.equal(result.movie, groups ? 'synthetic movie' : undefined)
      }
      assertAccess(JSON.parse(fs.readFileSync(report, 'utf8')))
      // The token path uses this same command through execFileSync.
      const command = businessProcessCommand(config, ['-e', `${inspect};console.log(JSON.stringify(result))`])
      assertAccess(JSON.parse(execFileSync(command.file, command.args, { ...command.credentials, encoding: 'utf8' })))
      await supervisor.shutdown(); supervisor = undefined
    }
  } finally {
    await supervisor?.shutdown()
    process.setgroups!(originalGroups)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
