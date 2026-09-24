// Real packaged startup with isolated legacy catalog/work-store fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'

const baseline = process.env.JAVDEX_BASELINE_EXECUTABLE
const current = process.env.JAVDEX_DESKTOP_EXECUTABLE
assert.ok(baseline && current, 'provide baseline and current packaged executables')
for (const file of [baseline, current]) assert.ok(path.isAbsolute(file) && fs.existsSync(file), file)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-work-upgrade-'))
const output = process.env.JAVDEX_WEB_QA_OUTPUT || path.join(root, 'evidence')
fs.mkdirSync(output, { recursive: true })
const env = { ...process.env, JAVDEX_TEST_USER_DATA: root }
delete env.ELECTRON_RUN_AS_NODE
let application
async function launch(executablePath) {
  application = await electron.launch({ executablePath, env })
  const page = await application.firstWindow()
  await page.waitForFunction(() => Boolean(window.api?.videos))
  return page
}
async function database(relative, sql, params = [], read = false) {
  return application.evaluate(({ app }, input) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const Database = require('better-sqlite3')
    const db = new Database(process.getBuiltinModule('path').join(app.getPath('userData'), input.relative))
    try {
      return input.read ? db.prepare(input.sql).all(...input.params) : db.prepare(input.sql).run(...input.params)
    } finally { db.close() }
  }, { relative, sql, params, read })
}
const insert = `INSERT INTO agent_runs(id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
  VALUES(?,'plugin-developer','closed','1','{}','pi',?,'fixture','fixture')`
try {
  await launch(baseline)
  await database('data/library.db', insert, ['legacy-upgrade-run', '{"marker":"legacy"}'])
  await application.close()
  application = null
  // Represent an installation that predates work-store extraction. All files are
  // confined to this script's fresh userData; never alter a real user profile.
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(root, 'desktop-work.db' + suffix), { force: true })
  let page = await launch(current)
  assert.deepEqual(await database('desktop-work.db', 'SELECT value FROM work_meta WHERE key=?', ['prepStatus'], true), [{ value: 'ready' }])
  const record = [{ id: 'legacy-upgrade-run', product_state_json: '{"marker":"legacy"}' }]
  const select = 'SELECT id,product_state_json FROM agent_runs WHERE id=?'
  assert.deepEqual(await database('desktop-work.db', select, ['legacy-upgrade-run'], true), record)
  assert.deepEqual(await database('data/library.db', select, ['legacy-upgrade-run'], true), record)
  await database('desktop-work.db', insert, ['new-work-run', '{"marker":"work"}'])
  await database('desktop-work.db', 'UPDATE agent_runs SET product_state_json=? WHERE id=?', ['{"marker":"updated"}', 'legacy-upgrade-run'])
  await page.screenshot({ path: path.join(output, 'local-after-migration.png') })
  await application.close()
  application = null
  page = await launch(current)
  assert.deepEqual(await database('desktop-work.db', select, ['legacy-upgrade-run'], true), [{ id: 'legacy-upgrade-run', product_state_json: '{"marker":"updated"}' }])
  assert.deepEqual(await database('desktop-work.db', select, ['new-work-run'], true), [{ id: 'new-work-run', product_state_json: '{"marker":"work"}' }])
  assert.deepEqual(await database('data/library.db', select, ['new-work-run'], true), [])
  assert.deepEqual(await database('data/library.db', select, ['legacy-upgrade-run'], true), record)
  await page.screenshot({ path: path.join(output, 'local-after-restart.png') })
  console.log(`PASS: packaged local startup copies legacy work, retains source and preserves new work on restart; evidence ${output}`)
} finally {
  await application?.close()
  // Retain isolated fixture databases with screenshots for inspecting migration evidence.
  console.log(`Fixture userData: ${root}`)
}
